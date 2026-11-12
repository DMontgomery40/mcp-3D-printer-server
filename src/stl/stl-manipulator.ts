import { normalize3mfMetadata } from "../slicer/3mf-xml.js";
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { detectProfilesRoot } from '../slicer/profile-flatten.js';
import { listModelPlates } from '../counterpart/model-plates.js';
import { flattenOrcaFilament } from '../slicer/filament-profiles.js';
import { mergeProcessKeys } from '../slicer/print-quality.js';
import {
  BambuCliProfilePreparer,
  assertSlicedProjectOutput,
  bambuCliFailureReason,
  readCliResult,
  buildBambuCliArgs,
  planBambuCliInput,
  type BambuCliSlicerType,
  type BambuSliceOptions,
} from '../slicer/bambu-cli.js';
import { runSlicerProcess } from '../slicer/run-slicer.js';
import { prepareSlicerLaunch } from '../slicer/slicer-launch.js';
import { keepSlice, restoreSlice, sliceCacheKey } from '../slicer/slice-cache.js';
import { SlicerError, asPreparationError } from '../slicer/slicer-error.js';
import { customGcodesWithPauses, layerTops, machinePauseGcode, pausedLayers, readPlateGcode, readProjectCustomGcodes } from '../slicer/layer-pauses.js';

export type { BambuSliceOptions } from '../slicer/bambu-cli.js';

/** A sliced file, with the slicer's own result.json when it wrote one. */
export type SliceOutput = { path: string; slicer_result?: Record<string, unknown> };

/** Print-sheet slicing overrides (PRD §8.4), applied on top of the selected profile. */
export interface ProcessOverrides {
  /** mm */
  layerHeight?: number;
  /** wall (perimeter) count */
  wallLoops?: number;
  /** e.g. "15%" */
  sparseInfillDensity?: string;
  /** From a strength choice: at least this many walls, keeping a profile's own higher count. */
  wallLoopsFloor?: number;
  /** From a strength choice: at least this density, keeping a profile's own denser infill. */
  sparseInfillDensityFloor?: string;
  enableSupport?: boolean;
  /** normal(auto), tree(auto), normal(manual) or tree(manual) */
  supportType?: string;
  /** degrees, 0-90 */
  supportThresholdAngle?: number;
}

/** Bambu Studio's and OrcaSlicer's support_type values. */
export const SUPPORT_TYPES = ["normal(auto)", "tree(auto)", "normal(manual)", "tree(manual)"] as const;

/** Support overrides only Bambu Studio and OrcaSlicer take; PrusaSlicer and Cura refuse them. */
function supportOverrideNames(overrides: ProcessOverrides | undefined): string[] {
  return [
    overrides?.enableSupport !== undefined ? "enable_support" : "",
    overrides?.supportType !== undefined ? "support_type" : "",
    overrides?.supportThresholdAngle !== undefined ? "support_threshold_angle" : "",
  ].filter(Boolean);
}

/** Orca/Bambu Studio process keys; profile JSON values are strings. */
export function orcaProcessOverrides(overrides: ProcessOverrides | undefined): Record<string, string> {
  const keys: Record<string, string> = {};
  if (overrides?.layerHeight !== undefined) keys.layer_height = String(overrides.layerHeight);
  if (overrides?.wallLoops !== undefined) keys.wall_loops = String(overrides.wallLoops);
  if (overrides?.sparseInfillDensity !== undefined) keys.sparse_infill_density = overrides.sparseInfillDensity;
  if (overrides?.wallLoopsFloor !== undefined) keys.wall_loops_floor = String(overrides.wallLoopsFloor);
  if (overrides?.sparseInfillDensityFloor !== undefined) keys.sparse_infill_density_floor = overrides.sparseInfillDensityFloor;
  if (overrides?.enableSupport !== undefined) keys.enable_support = overrides.enableSupport ? "1" : "0";
  if (overrides?.supportType !== undefined) keys.support_type = overrides.supportType;
  if (overrides?.supportThresholdAngle !== undefined) keys.support_threshold_angle = String(overrides.supportThresholdAngle);
  return keys;
}

/**
 * `--no-binary-gcode` when a loaded PrusaSlicer config turns binary G-code on (`binary_gcode = 1`, the default of
 * Prusa's MK4, MK4S, MINI, XL and CORE One printer profiles once binary output is enabled in Preferences). PrusaSlicer
 * then writes binary bytes even into a .gcode output (checked with PrusaSlicer 2.8.1). This server inspects the exact
 * G-code before it prints, and OctoPrint, Klipper, Duet and Repetier stream plain text; PrusaLink takes plain text
 * too. Only a config that names the key gets the option, so PrusaSlicer before 2.7 (no such option) is unaffected.
 * Prusa: https://help.prusa3d.com/article/binary-g-code_646763
 */
export function prusaSlicerPlainGcodeArgs(slicerType: string, loadedConfigs: string[]): string[] {
  if (slicerType !== 'prusaslicer') return [];
  let binary = false;
  for (const config of loadedConfigs) {
    let text = '';
    try { text = fs.readFileSync(config, 'utf8'); } catch { continue; }
    const match = /^\s*binary_gcode\s*=\s*(\d)/m.exec(text);
    if (match) binary = match[1] === '1';
  }
  return binary ? ['--no-binary-gcode'] : [];
}

/** Binary G-code (bgcode) starts with the magic "GCDE" (libbgcode's file header). */
export function isBinaryGcode(file: string): boolean {
  const head = Buffer.alloc(4);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    return fs.readSync(fd, head, 0, 4, 0) === 4 && head.toString('latin1') === 'GCDE';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * PrusaSlicer/Slic3r command-line options, which override the loaded config. A strength floor keeps the
 * loaded config's own `perimeters` / `fill_density` when they are already higher.
 */
export function prusaSlicerOverrideArgs(overrides: ProcessOverrides | undefined, loadedConfigs: string[] = []): string[] {
  const unsupported = supportOverrideNames(overrides);
  if (unsupported.length) throw new Error(`${unsupported.join(", ")} apply to Bambu Studio and OrcaSlicer only; set them in the PrusaSlicer config passed as slicer_profile.`);
  const args: string[] = [];
  if (overrides?.layerHeight !== undefined) args.push('--layer-height', String(overrides.layerHeight));
  const own = (key: string) => {
    let value: number | undefined;
    for (const config of loadedConfigs) {
      let text = '';
      try { text = fs.readFileSync(config, 'utf8'); } catch { continue; }
      const match = new RegExp(`^\\s*${key}\\s*=\\s*([\\d.]+)`, 'm').exec(text);
      if (match) value = Number(match[1]);
    }
    return value;
  };
  const floor = (exact: number | undefined, minimum: number | undefined, key: string) =>
    exact ?? (minimum === undefined ? undefined : Math.max(minimum, own(key) ?? -1));
  const walls = floor(overrides?.wallLoops, overrides?.wallLoopsFloor, 'perimeters');
  const densityValue = floor(overrides?.sparseInfillDensity === undefined ? undefined : Number.parseFloat(overrides.sparseInfillDensity),
    overrides?.sparseInfillDensityFloor === undefined ? undefined : Number.parseFloat(overrides.sparseInfillDensityFloor), 'fill_density');
  const density = overrides?.sparseInfillDensity ?? (densityValue === undefined ? undefined : `${densityValue}%`);
  if (walls !== undefined) args.push('--perimeters', String(walls));
  if (density !== undefined) args.push('--fill-density', density);
  return args;
}
import { execFile } from 'child_process';
import { scanGcodeThermal } from '../safety/gcode-thermal.js';

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const DEFAULT_SLICER_TIMEOUT_MS = 10 * 60 * 1000;

// Define types for progress tracking
export type ProgressCallback = (progress: number, message?: string) => void;
export type OperationResult = {
  success: boolean;
  filePath?: string;
  error?: string;
  operationId: string;
};

export type SlicerType =
  | 'prusaslicer'
  | 'cura'
  | 'slic3r'
  | 'orcaslicer'
  | 'orcaslicer-bambulab'
  | 'bambustudio';

// Define possible transformation operations
export type TransformationType = 'scale' | 'rotate' | 'translate' | 'extendBase' | 'customModify';
export type TransformationAxis = 'x' | 'y' | 'z' | 'all';
export type BoundingBox = {
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  dimensions: THREE.Vector3;
};

// Define transformation parameters
export type TransformationParams = {
  type: TransformationType;
  axis?: TransformationAxis;
  value: number | number[];
  relative?: boolean;
  selectionBounds?: THREE.Box3;
};

export class STLManipulator extends EventEmitter {
  private tempDir: string;
  private activeOperations: Map<string, boolean> = new Map();

  constructor(tempDir: string = path.join(process.cwd(), 'temp')) {
    super();
    this.tempDir = tempDir;
    // Ensure temp directory exists
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Generate a unique operation ID
   */
  private generateOperationId(): string {
    return crypto.randomUUID();
  }

  /**
   * Each operation writes into its own folder. Outputs named only after the
   * input (for example bracket_extended.stl) would otherwise let two
   * concurrent requests replace each other's file before it is used or printed.
   */
  private operationOutputPath(operationId: string, fileName: string): string {
    const directory = path.join(this.tempDir, `${operationId}-out`);
    fs.mkdirSync(directory, { recursive: true });
    return path.join(directory, fileName);
  }

  private validateSlicerExecutable(slicerPath: string): void {
    if (!slicerPath.trim()) {
      throw new Error("Slicer executable path is required.");
    }

    const looksLikePath = path.isAbsolute(slicerPath) || /[\\/]/.test(slicerPath);
    if (looksLikePath && !fs.existsSync(slicerPath)) {
      throw new Error(`Slicer executable not found at: ${slicerPath}`);
    }
  }

  private splitProfileList(profileList?: string): string[] {
    return (profileList || "")
      .split(";")
      .map((profile) => profile.trim())
      .filter((profile) => profile.length > 0);
  }

  private parseOrcaProfileArgs(
    slicerProfile?: string,
    filamentProfile?: string
  ): { settingsProfiles: string[]; filamentProfiles: string[] } {
    const [settingsSegment = "", filamentSegment = ""] = (slicerProfile || "").split("|", 2);

    return {
      settingsProfiles: this.splitProfileList(settingsSegment),
      filamentProfiles: [
        ...this.splitProfileList(filamentSegment),
        ...this.splitProfileList(filamentProfile),
      ],
    };
  }

  private warnForMissingProfiles(profiles: string[], label: string): void {
    for (const profile of profiles) {
      if (!fs.existsSync(profile)) {
        console.warn(`${label} specified but not found: ${profile}. Slicer might use defaults.`);
      }
    }
  }

  /**
   * Generic OrcaSlicer: write the overrides over a copy of the process profile
   * (the settings file whose type is "process", else the last of two or more).
   */
  private withOrcaProcessOverrides(
    profiles: { settingsProfiles: string[]; filamentProfiles: string[] },
    overrides: ProcessOverrides | undefined,
    outputDir: string
  ): { settingsProfiles: string[]; filamentProfiles: string[] } {
    const keys = orcaProcessOverrides(overrides);
    if (!Object.keys(keys).length) return profiles;
    const parsed = profiles.settingsProfiles.map((profile) => {
      try { return JSON.parse(fs.readFileSync(profile, 'utf8')); } catch { return undefined; }
    });
    let index = parsed.findIndex((profile) => profile?.type === 'process');
    if (index < 0 && profiles.settingsProfiles.length >= 2) index = profiles.settingsProfiles.length - 1;
    if (index < 0 || !parsed[index] || typeof parsed[index] !== 'object') {
      throw new SlicerError('preparation',
        'layer_height, wall_loops and sparse_infill_density need a readable process profile for generic OrcaSlicer. ' +
        "Pass slicer_profile as 'machine.json;process.json', or slice with bambu_model.",
        { slicerType: 'orcaslicer' });
    }
    const merged = path.join(outputDir, `process-overrides-${path.basename(profiles.settingsProfiles[index])}`);
    fs.writeFileSync(merged, JSON.stringify(mergeProcessKeys(parsed[index], keys), null, 2));
    const settingsProfiles = [...profiles.settingsProfiles];
    settingsProfiles[index] = merged;
    return { ...profiles, settingsProfiles };
  }

  /** Bundled and user Orca filament presets inherit their settings; the CLI needs them merged in. */
  private async withFlattenedOrcaFilaments<T extends { settingsProfiles: string[]; filamentProfiles: string[] }>(
    profiles: T, slicerPath: string, outputDir: string
  ): Promise<T> {
    const filamentProfiles = await Promise.all(profiles.filamentProfiles.map(async (profile, index) => {
      const flat = await flattenOrcaFilament(profile, { slicerPath }).catch(() => undefined);
      if (!flat) return profile;
      const merged = path.join(outputDir, `filament-${index + 1}-${path.basename(profile)}`);
      fs.writeFileSync(merged, JSON.stringify(flat, null, 2));
      return merged;
    }));
    return { ...profiles, filamentProfiles };
  }

  private appendOrcaProfileArgs(
    args: string[],
    profiles: { settingsProfiles: string[]; filamentProfiles: string[] }
  ): void {
    for (const profile of profiles.settingsProfiles) {
      args.push('--load-settings', profile);
    }
    for (const profile of profiles.filamentProfiles) {
      args.push('--load-filaments', profile);
    }
  }

  private resolveOrcaGcodeOutput(outputDir: string): string {
    const preferredPath = path.join(outputDir, 'plate_1.gcode');
    if (fs.existsSync(preferredPath)) {
      return preferredPath;
    }

    const plateOutputs = fs.readdirSync(outputDir)
      .filter((entry) => /^plate_\d+\.gcode$/i.test(entry))
      .sort((a, b) => {
        const aNumber = Number(a.match(/\d+/)?.[0] || 0);
        const bNumber = Number(b.match(/\d+/)?.[0] || 0);
        return aNumber - bNumber;
      });

    if (plateOutputs.length === 0) {
      throw new Error(`OrcaSlicer finished but no plate_N.gcode file was found in: ${outputDir}`);
    }

    return path.join(outputDir, plateOutputs[0]);
  }

  private resolveSlicerTimeoutMs(): number {
    const rawTimeout = process.env.SLICER_TIMEOUT_MS?.trim();
    if (!rawTimeout) {
      return DEFAULT_SLICER_TIMEOUT_MS;
    }

    const timeoutMs = Number(rawTimeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      console.warn(`Invalid SLICER_TIMEOUT_MS value "${rawTimeout}", using ${DEFAULT_SLICER_TIMEOUT_MS}.`);
      return DEFAULT_SLICER_TIMEOUT_MS;
    }

    return timeoutMs;
  }

  /**
   * Apply slice_stl's scale and rotations to a copy of the mesh as OrcaSlicer's
   * CLI would, about the model's centre. Orca adds each --rotate* to the
   * object's Euler angles (ModelVolume::rotate), so the result rotates about X,
   * then Y, then Z whatever the argument order, after scaling. The slicer then
   * places the result on the plate.
   */
  private async transformMeshForCli(stlFilePath: string, options: BambuSliceOptions, outputDir: string): Promise<string> {
    const { geometry, boundingBox } = await this.loadSTL(stlFilePath);
    const center = new THREE.Vector3();
    boundingBox.getCenter(center);
    const radians = (degrees: number) => degrees * Math.PI / 180;
    geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
    if (options.scale !== undefined) geometry.applyMatrix4(new THREE.Matrix4().makeScale(options.scale, options.scale, options.scale));
    if (options.rotateX) geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(radians(options.rotateX)));
    if (options.rotateY) geometry.applyMatrix4(new THREE.Matrix4().makeRotationY(radians(options.rotateY)));
    if (options.rotate) geometry.applyMatrix4(new THREE.Matrix4().makeRotationZ(radians(options.rotate)));
    geometry.applyMatrix4(new THREE.Matrix4().makeTranslation(center.x, center.y, center.z));
    return this.saveSTL(geometry, path.join(outputDir, `${path.basename(stlFilePath, path.extname(stlFilePath))}_transformed.stl`));
  }

  /**
   * Load STL file and return geometry and bounding box
   */
  private async loadSTL(stlFilePath: string, 
                        progressCallback?: ProgressCallback): Promise<{
    geometry: THREE.BufferGeometry;
    boundingBox: THREE.Box3;
    mesh: THREE.Mesh;
  }> {
    try {
      if (progressCallback) progressCallback(10, "Loading STL file...");
      
      // Read the STL file
      const stlData = await readFileAsync(stlFilePath);
      
      if (progressCallback) progressCallback(30, "Parsing STL data...");
      
      // Load the STL data into a Three.js geometry
      const loader = new STLLoader();
      const rawArrayBuffer = stlData.buffer.slice(
        stlData.byteOffset,
        stlData.byteOffset + stlData.byteLength
      ) as ArrayBuffer;
      const geometry = loader.parse(rawArrayBuffer);
      
      // Create a mesh from the geometry
      const material = new THREE.MeshStandardMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      
      // Compute the bounding box
      geometry.computeBoundingBox();
      const boundingBox = geometry.boundingBox!;
      
      if (progressCallback) progressCallback(50, "STL loaded successfully");
      
      return { geometry, boundingBox, mesh };
    } catch (error) {
      console.error("Error loading STL file:", error);
      throw new Error(`Failed to load STL file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Save a geometry to STL file
   */
  private async saveSTL(geometry: THREE.BufferGeometry, 
                       outputFilePath: string, 
                       progressCallback?: ProgressCallback): Promise<string> {
    try {
      if (progressCallback) progressCallback(80, "Exporting to STL...");
      
      // Create mesh for export
      const material = new THREE.MeshStandardMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      
      // Export the mesh as STL
      const exporter = new STLExporter();
      const stlString = exporter.parse(mesh);
      
      // Write the STL to file
      await writeFileAsync(outputFilePath, stlString);
      
      if (progressCallback) progressCallback(100, "STL saved successfully");
      
      return outputFilePath;
    } catch (error) {
      console.error("Error saving STL file:", error);
      throw new Error(`Failed to save STL file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get comprehensive information about an STL file
   */
  async getSTLInfo(stlFilePath: string): Promise<{
    filePath: string;
    fileName: string;
    fileSize: number;
    boundingBox: BoundingBox;
    vertexCount: number;
    faceCount: number;
  }> {
    try {
      const { geometry, boundingBox } = await this.loadSTL(stlFilePath);
      const fileStats = fs.statSync(stlFilePath);
      
      // Count faces (each face is a triangle in STL)
      const positionAttribute = geometry.getAttribute('position');
      const vertexCount = positionAttribute.count;
      const faceCount = vertexCount / 3;
      
      // Calculate center and dimensions
      const center = new THREE.Vector3();
      boundingBox.getCenter(center);
      
      const dimensions = new THREE.Vector3();
      boundingBox.getSize(dimensions);
      
      return {
        filePath: stlFilePath,
        fileName: path.basename(stlFilePath),
        fileSize: fileStats.size,
        boundingBox: {
          min: boundingBox.min,
          max: boundingBox.max,
          center,
          dimensions
        },
        vertexCount,
        faceCount
      };
    } catch (error) {
      console.error("Error getting STL info:", error);
      throw new Error(`Failed to get STL info: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Scale an STL model uniformly or along specific axes
   */
  async scaleSTL(
    stlFilePath: string,
    scaleFactors: number | [number, number, number],
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting scaling operation...");
      
      // Load the STL file
      const { geometry, mesh } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Applying scaling transformation...");
      
      // Apply scaling
      let scaleX, scaleY, scaleZ;
      if (typeof scaleFactors === 'number') {
        // Uniform scaling
        scaleX = scaleY = scaleZ = scaleFactors;
      } else {
        // Non-uniform scaling
        [scaleX, scaleY, scaleZ] = scaleFactors;
      }
      
      const scaleMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
      geometry.applyMatrix4(scaleMatrix);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_scaled.stl';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);
      
      // Save the modified STL
      await this.saveSTL(geometry, outputFilePath, progressCallback);
      
      this.emit('operationComplete', {
        operationId,
        type: 'scale',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('operationError', {
        operationId,
        type: 'scale',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Rotate an STL model around specific axes
   */
  async rotateSTL(
    stlFilePath: string,
    rotationAngles: [number, number, number], // [x, y, z] in degrees
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting rotation operation...");
      
      // Load the STL file
      const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Applying rotation transformation...");
      
      // Convert degrees to radians
      const [rotX, rotY, rotZ] = rotationAngles.map(angle => angle * Math.PI / 180);
      
      // Get the center of the model
      const center = new THREE.Vector3();
      boundingBox.getCenter(center);
      
      // Create translation matrices to rotate around the center
      const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(rotX, rotY, rotZ, 'XYZ')
      );
      const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
      
      // Apply the transformations
      geometry.applyMatrix4(toOriginMatrix);
      geometry.applyMatrix4(rotationMatrix);
      geometry.applyMatrix4(fromOriginMatrix);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_rotated.stl';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);
      
      // Save the modified STL
      await this.saveSTL(geometry, outputFilePath, progressCallback);
      
      this.emit('operationComplete', {
        operationId,
        type: 'rotate',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('operationError', {
        operationId,
        type: 'rotate',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Translate (move) an STL model along specific axes
   */
  async translateSTL(
    stlFilePath: string,
    translationValues: [number, number, number], // [x, y, z] in mm
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting translation operation...");
      
      // Load the STL file
      const { geometry } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Applying translation transformation...");
      
      // Apply translation
      const [translateX, translateY, translateZ] = translationValues;
      const translationMatrix = new THREE.Matrix4().makeTranslation(translateX, translateY, translateZ);
      geometry.applyMatrix4(translationMatrix);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_translated.stl';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);
      
      // Save the modified STL
      await this.saveSTL(geometry, outputFilePath, progressCallback);
      
      this.emit('operationComplete', {
        operationId,
        type: 'translate',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('operationError', {
        operationId,
        type: 'translate',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Cancel an ongoing operation
   */
  cancelOperation(operationId: string): boolean {
    if (this.activeOperations.has(operationId)) {
      this.activeOperations.set(operationId, false);
      this.emit('operationCancelled', { operationId });
      return true;
    }
    return false;
  }

  /**
   * Generate an SVG visualization of an STL file from multiple angles
   * @param stlFilePath Path to the STL file
   * @param width Width of each view in pixels
   * @param height Height of each view in pixels
   * @param progressCallback Optional callback for progress updates
   * @returns Path to the generated SVG file
   */
  async generateVisualization(
    stlFilePath: string,
    width: number = 300,
    height: number = 300,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting visualization generation...");
      
      // Load the STL file
      const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(50, "Setting up 3D scene...");
      
      // Create a scene
      const scene = new THREE.Scene();
      scene.add(mesh);
      
      // Create a camera
      const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
      
      // Calculate the ideal camera position based on bounding box
      const size = new THREE.Vector3();
      boundingBox.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = camera.fov * (Math.PI / 180);
      const cameraDistance = (maxDim / 2) / Math.tan(fov / 2) * 1.5; // 1.5 is a factor for some padding
      
      // Add lighting to the scene
      const ambientLight = new THREE.AmbientLight(0x404040); // soft white light
      scene.add(ambientLight);
      
      const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
      directionalLight.position.set(1, 1, 1).normalize();
      scene.add(directionalLight);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Generating SVG representation...");
      
      // Since we can't use the DOM-dependent SVGRenderer in a Node.js environment,
      // let's create a simple representation of the model using its bounding box
      // This is a simplified visual representation
      
      // Create SVG content with a simple representation of the STL model
      const viewBox = `0 0 ${width * 2} ${height * 2}`;
      let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width * 2}" height="${height * 2}">`;
      
      // Add a title and model info
      svgContent += `
        <text x="10" y="20" font-family="Arial" font-size="16" fill="black">
          STL Visualization: ${path.basename(stlFilePath)}
        </text>
        <text x="10" y="40" font-family="Arial" font-size="12" fill="black">
          Dimensions: ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} mm
        </text>
      `;
      
      // Define views
      const views = [
        { name: "front", transform: "rotateY(0deg)" },
        { name: "side", transform: "rotateY(90deg)" },
        { name: "top", transform: "rotateX(90deg)" },
        { name: "isometric", transform: "rotateX(30deg) rotateY(45deg)" }
      ];

      // Draw each view
      for (let i = 0; i < views.length; i++) {
        const view = views[i];
        const x = (i % 2) * width + width / 2;
        const y = Math.floor(i / 2) * height + height / 2 + 50; // Add 50px for the header text
        
        // Calculate a representative size for the simple cube visualization
        const cubeSize = Math.min(width, height) * 0.4;
        
        // Draw a simple cube representation
        svgContent += `
          <g transform="translate(${x}, ${y})">
            <rect x="${-cubeSize/2}" y="${-cubeSize/2}" width="${cubeSize}" height="${cubeSize}" 
                  style="fill:#e0e0e0;stroke:#000;stroke-width:1;opacity:0.8;${view.transform}" />
            <text x="0" y="${cubeSize/2 + 30}" text-anchor="middle" font-family="Arial" font-size="12" fill="black">
              ${view.name}
            </text>
          </g>
        `;
        
        if (progressCallback) progressCallback(60 + (i + 1) * 10, `Generated ${view.name} view`);
      }
      
      // Add STL information
      svgContent += `
        <g transform="translate(20, ${height * 2 - 60})">
          <text font-family="Arial" font-size="14" fill="black">
            File: ${path.basename(stlFilePath)}
          </text>
          <text y="20" font-family="Arial" font-size="12" fill="black">
            Vertices: ${mesh.geometry.attributes.position.count / 3}
          </text>
          <text y="40" font-family="Arial" font-size="12" fill="black">
            Dimensions: W:${size.x.toFixed(2)}mm × H:${size.y.toFixed(2)}mm × D:${size.z.toFixed(2)}mm
          </text>
        </g>
      `;
      
      // Close the SVG
      svgContent += '</svg>';

      if (progressCallback) progressCallback(90, "Visualization generated");
      
      if (progressCallback) progressCallback(90, "Saving visualization...");
      
      // Write the SVG to file
      const outputFileName = path.basename(stlFilePath, '.stl') + '_visualization.svg';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);
      
      await writeFileAsync(outputFilePath, svgContent);
      
      if (progressCallback) progressCallback(100, "Visualization saved successfully");
      
      this.emit('operationComplete', {
        operationId,
        type: 'visualization',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      console.error("Error generating visualization:", error);
      
      this.emit('operationError', {
        operationId,
        type: 'visualization',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw new Error(`Failed to generate visualization: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Apply a specific transformation to a selected section of an STL file
   * This allows for targeted modifications of specific parts of a model
   */
  async modifySection(
    stlFilePath: string,
    selection: THREE.Box3 | 'top' | 'bottom' | 'center', 
    transformation: TransformationParams,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting section modification...");
      
      // Load the STL file
      const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(40, "Identifying section to modify...");
      
      // Convert named sections to actual bounding boxes
      let selectionBox: THREE.Box3;
      if (selection === 'top') {
        // Select top third of the model
        const height = boundingBox.max.y - boundingBox.min.y;
        const topThreshold = boundingBox.max.y - (height / 3);
        selectionBox = new THREE.Box3(
          new THREE.Vector3(boundingBox.min.x, topThreshold, boundingBox.min.z),
          new THREE.Vector3(boundingBox.max.x, boundingBox.max.y, boundingBox.max.z)
        );
      } else if (selection === 'bottom') {
        // Select bottom third of the model
        const height = boundingBox.max.y - boundingBox.min.y;
        const bottomThreshold = boundingBox.min.y + (height / 3);
        selectionBox = new THREE.Box3(
          new THREE.Vector3(boundingBox.min.x, boundingBox.min.y, boundingBox.min.z),
          new THREE.Vector3(boundingBox.max.x, bottomThreshold, boundingBox.max.z)
        );
      } else if (selection === 'center') {
        // Select middle third of the model
        const height = boundingBox.max.y - boundingBox.min.y;
        const bottomThreshold = boundingBox.min.y + (height / 3);
        const topThreshold = boundingBox.max.y - (height / 3);
        selectionBox = new THREE.Box3(
          new THREE.Vector3(boundingBox.min.x, bottomThreshold, boundingBox.min.z),
          new THREE.Vector3(boundingBox.max.x, topThreshold, boundingBox.max.z)
        );
      } else {
        // Use the provided bounding box
        selectionBox = selection;
      }
      
      if (progressCallback) progressCallback(50, "Applying transformation to selected section...");
      
      // Get position attribute for direct manipulation
      const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
      const positions = positionAttribute.array;
      
      // Create transformation matrix based on the requested operation
      let transformMatrix = new THREE.Matrix4();
      const center = new THREE.Vector3();
      selectionBox.getCenter(center);
      
      // Matrices for transforming around the selection center
      const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);
      
      // Build the appropriate transformation matrix
      switch (transformation.type) {
        case 'scale':
          if (typeof transformation.value === 'number') {
            transformMatrix = new THREE.Matrix4().makeScale(
              transformation.value,
              transformation.value,
              transformation.value
            );
          } else {
            const [scaleX, scaleY, scaleZ] = transformation.value as number[];
            transformMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
          }
          break;
          
        case 'rotate':
          const rotValues = (typeof transformation.value === 'number') 
            ? [0, 0, transformation.value * Math.PI / 180] 
            : (transformation.value as number[]).map(v => v * Math.PI / 180);
          
          transformMatrix = new THREE.Matrix4().makeRotationFromEuler(
            new THREE.Euler(rotValues[0], rotValues[1], rotValues[2], 'XYZ')
          );
          break;
          
        case 'translate':
          if (typeof transformation.value === 'number') {
            const translateValue = transformation.value;
            transformMatrix = new THREE.Matrix4().makeTranslation(
              translateValue,
              translateValue,
              translateValue
            );
          } else {
            const [transX, transY, transZ] = transformation.value as number[];
            transformMatrix = new THREE.Matrix4().makeTranslation(transX, transY, transZ);
          }
          break;
          
        default:
          throw new Error(`Unsupported transformation type: ${transformation.type}`);
      }
      
      // Build complete transformation (to origin, transform, back from origin)
      const finalTransform = new THREE.Matrix4()
        .multiply(fromOriginMatrix)
        .multiply(transformMatrix)
        .multiply(toOriginMatrix);
      
      // Create temporary vector for calculations
      const tempVector = new THREE.Vector3();
      
      try {
        // Apply transformation only to vertices within the selection box
        for (let i = 0; i < positionAttribute.count; i++) {
          tempVector.fromBufferAttribute(positionAttribute, i);
          
          // Check if this vertex is within our selection box
          if (selectionBox.containsPoint(tempVector)) {
            // Apply the transformation to this vertex
            tempVector.applyMatrix4(finalTransform);
            
            // Update the position in the buffer
            positionAttribute.setXYZ(i, tempVector.x, tempVector.y, tempVector.z);
          }
        }
        
        // Mark the attribute as needing an update
        positionAttribute.needsUpdate = true;
        
        // Update the geometry's bounding box
        geometry.computeBoundingBox();
      } catch (error) {
        console.error("Error modifying vertices:", error);
        throw new Error(`Failed to modify section: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_modified.stl';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);
      
      // Save the modified STL
      await this.saveSTL(geometry, outputFilePath, progressCallback);
      
      this.emit('operationComplete', {
        operationId,
        type: 'modifySection',
        success: true,
        output: outputFilePath
      });
      
      return outputFilePath;
    } catch (error) {
      this.emit('operationError', {
        operationId,
        type: 'modifySection',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Enhanced version of extendBase with progress reporting
   * @param stlFilePath Path to the input STL file
   * @param extensionInches Amount to extend base in inches
   * @param progressCallback Optional callback for progress updates
   * @returns Path to the modified STL file
   */
  async extendBase(
    stlFilePath: string, 
    extensionInches: number,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting base extension operation...");
      console.error(`Extending base of ${stlFilePath} by ${extensionInches} inches`);
      
      // Load the STL file
      const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(60, "Creating extended base geometry...");
      
      // STL files and slicers are Z-up: the base goes under the model.
      const minZ = boundingBox.min.z;
      
      // Convert inches to millimeters (STL files typically use mm)
      const extensionMm = extensionInches * 25.4;
      
      // Raise the model by the extension amount
      const matrix = new THREE.Matrix4().makeTranslation(0, 0, extensionMm);
      geometry.applyMatrix4(matrix);
      
      // A box spanning the model's X/Y footprint fills the new space below it
      const baseWidth = boundingBox.max.x - boundingBox.min.x;
      const baseDepth = boundingBox.max.y - boundingBox.min.y;
      const baseGeometry = new THREE.BoxGeometry(
        baseWidth,
        baseDepth,
        extensionMm
      );
      
      // Position the base geometry
      const baseMatrix = new THREE.Matrix4().makeTranslation(
        (boundingBox.min.x + boundingBox.max.x) / 2,
        (boundingBox.min.y + boundingBox.max.y) / 2,
        minZ + extensionMm / 2
      );
      baseGeometry.applyMatrix4(baseMatrix);
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(70, "Merging geometries...");
      
      if (progressCallback) progressCallback(75, "Creating merged geometry...");
      
      // Create material for both meshes
      const material = new THREE.MeshStandardMaterial();
      
      // Create individual meshes
      const originalMesh = new THREE.Mesh(geometry, material);
      const baseMesh = new THREE.Mesh(baseGeometry, material);
      
      // Export each mesh separately and merge the STL strings
      const exporter = new STLExporter();
      
      const originalStl = exporter.parse(originalMesh);
      const baseStl = exporter.parse(baseMesh);
      
      // Generate output file path
      const outputFileName = path.basename(stlFilePath, '.stl') + '_extended.stl';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);
      
      if (progressCallback) progressCallback(90, "Saving extended STL...");
      
      // Write the combined STL data to file
      await writeFileAsync(outputFilePath, originalStl + baseStl);
      
      if (progressCallback) progressCallback(100, "STL saved successfully");
      
      this.emit('operationComplete', {
        operationId,
        type: 'extendBase',
        success: true,
        output: outputFilePath
      });
      
      console.error(`Modified STL saved to ${outputFilePath}`);
      return outputFilePath;
    } catch (error) {
      console.error("Error extending STL base:", error);
      
      this.emit('operationError', {
        operationId,
        type: 'extendBase',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw new Error(`Failed to extend STL base: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Bambu-compatible CLI slicing applies when the slicer is BambuStudio or
   * FULU OrcaSlicer-bambulab, or when generic OrcaSlicer is given an explicit
   * Bambu machine preset. Generic OrcaSlicer without a preset keeps its
   * user-supplied machine/process profile path.
   */
  static usesBambuCliPreparation(slicerType: SlicerType, printerPreset?: string): boolean {
    return (
      slicerType === 'bambustudio' ||
      slicerType === 'orcaslicer-bambulab' ||
      (slicerType === 'orcaslicer' && Boolean(printerPreset))
    );
  }

  /**
   * Slice an STL or 3MF file using the specified slicer
   * @param stlFilePath Path to the input STL or 3MF file
   * @param slicerType Type of slicer (prusaslicer, cura, slic3r, orcaslicer, orcaslicer-bambulab, bambustudio)
   * @param slicerPath Path to the slicer executable
   * @param slicerProfile Optional slicer profile/config file. For Bambu-compatible
   *   CLI slicing this is a process profile; the machine comes from printerPreset.
   * @param progressCallback Optional callback for progress updates
   * @param printerPreset Bambu machine preset name, e.g. "Bambu Lab P1S 0.4 nozzle"
   * @param filamentProfile Optional filament profile path(s), ';'-separated
   * @param bambuOptions Optional Bambu-compatible CLI options (added last for compatibility)
   * @returns Path to the generated G-code or sliced 3MF file
   */
  async sliceSTL(
    stlFilePath: string,
    slicerType: SlicerType,
    slicerPath: string,
    slicerProfile?: string,
    progressCallback?: ProgressCallback,
    printerPreset?: string,
    filamentProfile?: string,
    bambuOptions?: BambuSliceOptions,
    processOverrides?: ProcessOverrides
  ): Promise<string> {
    return (await this.sliceSTLWithResult(stlFilePath, slicerType, slicerPath, slicerProfile, progressCallback,
      printerPreset, filamentProfile, bambuOptions, processOverrides)).path;
  }

  /**
   * sliceSTL with the Bambu-compatible CLI's own result.json, parsed verbatim.
   * A failure's SlicerError carries it too, and its message starts with the
   * slicer's error_string and plate warnings.
   */
  async sliceSTLWithResult(
    stlFilePath: string,
    slicerType: SlicerType,
    slicerPath: string,
    slicerProfile?: string,
    progressCallback?: ProgressCallback,
    printerPreset?: string,
    filamentProfile?: string,
    bambuOptions?: BambuSliceOptions,
    processOverrides?: ProcessOverrides
  ): Promise<SliceOutput> {
    const once = (options?: BambuSliceOptions) => this.sliceSTLOnce(stlFilePath, slicerType, slicerPath,
      slicerProfile, progressCallback, printerPreset, filamentProfile, options, processOverrides);
    const layers = bambuOptions?.pauseAtLayers?.length ? bambuOptions.pauseAtLayers : undefined;
    const cli = STLManipulator.usesBambuCliPreparation(slicerType, printerPreset);
    // Without new pauses the CLI keeps the project's own pauses and colour changes itself: it loads a
    // Bambu 3MF's Metadata/custom_gcode_per_layer.xml with the project (Bambu Studio 02.08.02.61
    // BambuStudio.cpp:1882, bbs_3mf.cpp:2051), so nothing is passed.
    if (!layers) return once(bambuOptions);
    if (!cli) throw new Error(`Pausing at a layer needs the Bambu Studio or OrcaSlicer CLI, not ${slicerType}.`);
    const chosenPlate = bambuOptions?.slicePlate && bambuOptions.slicePlate > 0 ? bambuOptions.slicePlate : undefined;
    const plate = chosenPlate ?? 1;
    const threeMf = /\.3mf$/i.test(stlFilePath);
    // --load-custom-gcodes replaces the whole per-plate map and holds one plate (--slice N, or plate 1 for
    // --slice 0: BambuStudio.cpp:2224-2233, 4005-4008), so slicing every plate would drop plates 2..n's own.
    if (threeMf && chosenPlate === undefined && (await listModelPlates(stlFilePath)).plate_count > 1) {
      throw new Error('Pausing at a layer works on one plate at a time. Choose the plate with slice_plate.');
    }
    // The map replaces the project's own entries for this plate, so they are merged in.
    const project = threeMf ? await readProjectCustomGcodes(stlFilePath, plate) : undefined;
    const customGcodesFile = path.join(this.tempDir, `custom-gcodes-${crypto.randomUUID()}.json`);
    try {
      if (progressCallback) progressCallback(10, `Finding layer heights for the pause before layer ${layers.join(", ")}`);
      const plain = await once({ ...bambuOptions, pauseAtLayers: undefined, customGcodesFile: undefined });
      const plainGcode = await readPlateGcode(plain.path, plate);
      if (!plainGcode) throw new Error('The slicer wrote no plate G-code, so the pause layers cannot be placed.');
      const tops = layerTops(plainGcode);
      await fs.promises.writeFile(customGcodesFile, JSON.stringify(customGcodesWithPauses(tops, layers, project)));
      const result = await once({ ...bambuOptions, customGcodesFile });
      const gcode = await readPlateGcode(result.path, plate);
      const placed = gcode ? pausedLayers(gcode, machinePauseGcode(gcode)) : [];
      const missing = layers.filter(layer => !placed.includes(layer));
      if (!gcode || missing.length || layerTops(gcode).length !== tops.length) {
        throw new Error(`The slicer did not place the pause before layer ${(missing.length ? missing : layers).join(", ")}. Nothing was sent to the printer.`);
      }
      return result;
    } finally { await fs.promises.rm(customGcodesFile, { force: true }); }
  }

  private async sliceSTLOnce(
    stlFilePath: string,
    slicerType: SlicerType,
    slicerPath: string,
    slicerProfile?: string,
    progressCallback?: ProgressCallback,
    printerPreset?: string,
    filamentProfile?: string,
    bambuOptions?: BambuSliceOptions,
    processOverrides?: ProcessOverrides
  ): Promise<SliceOutput> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    const bambuCli = STLManipulator.usesBambuCliPreparation(slicerType, printerPreset);

    let orcaOutputDir: string | undefined;
    let bambuOutputDir: string | undefined;

    try {
      try {
        this.validateSlicerExecutable(slicerPath);
      } catch (error) {
        throw asPreparationError(error, { slicerType, slicerPath });
      }
      if (!fs.existsSync(stlFilePath)) {
        throw new SlicerError('preparation', `Input model not found: ${stlFilePath}`, { slicerType, slicerPath });
      }

      const orcaProfiles = this.parseOrcaProfileArgs(slicerProfile, filamentProfile);
      if (!bambuCli) {
        if (slicerType === 'orcaslicer') {
          this.warnForMissingProfiles(orcaProfiles.settingsProfiles, 'Slicer profile');
          this.warnForMissingProfiles(orcaProfiles.filamentProfiles, 'Filament profile');
        } else if (slicerProfile && !fs.existsSync(slicerProfile)) {
          console.warn(`Slicer profile specified but not found: ${slicerProfile}. Slicer might use defaults.`);
        }
      }

      const outputFileName = path.basename(stlFilePath, '.stl') + '.gcode';
      let outputFilePath = this.operationOutputPath(operationId, outputFileName);
      let args: string[] = [];
      let bambuExport: { producedPath: string; finalPath: string } | undefined;

      if (progressCallback) progressCallback(0, `Starting slicing with ${slicerType}...`);

      if (bambuCli) {
        // Bambu-compatible CLI: resolve the exact machine preset and every
        // profile dependency, then slice and export a 3MF with plate G-code.
        const cliType = slicerType as BambuCliSlicerType;
        const is3mf = stlFilePath.toLowerCase().endsWith('.3mf');
        const outputBase = path.basename(stlFilePath, is3mf ? '.3mf' : '.stl');
        const exportName = `${outputBase}_sliced.3mf`;
        try {
          if (orcaProfiles.settingsProfiles.length > 1) {
            throw new Error(
              `slicer_profile (or SLICER_PROFILE) lists ${orcaProfiles.settingsProfiles.length} settings files, but Bambu-compatible CLI slicing ` +
              'takes one process profile. Set slicer_profile/SLICER_PROFILE to a process profile only (or leave it empty for the ' +
              "preset's default process); the machine preset comes from bambu_model/BAMBU_MODEL and nozzle_diameter/NOZZLE_DIAMETER. " +
              'Pass filaments with filament_profile/load_filaments. For a non-Bambu printer, use slicer_type orcaslicer without bambu_model ' +
              'to keep the machine;process|filament format.'
            );
          }
          const options: BambuSliceOptions = { ...bambuOptions };
          const overrideKeys = orcaProcessOverrides(processOverrides);
          if (Object.keys(overrideKeys).length) options.processOverrides = overrideKeys;
          if (orcaProfiles.filamentProfiles.length > 0) {
            const legacyFilaments = orcaProfiles.filamentProfiles.join(';');
            if (options.loadFilaments && this.splitProfileList(options.loadFilaments).join(';') !== legacyFilaments) {
              throw new Error('Provide either load_filaments or filament_profile, not conflicting values.');
            }
            options.loadFilaments = legacyFilaments;
          }
          const cliInput = planBambuCliInput(cliType, is3mf, options);
          const profilesRoot = detectProfilesRoot(slicerPath, cliType);
          const preparer = new BambuCliProfilePreparer(path.join(this.tempDir, 'slicer-profiles'));
          const bundle = await preparer.prepare(
            stlFilePath,
            outputBase,
            cliType,
            profilesRoot,
            printerPreset,
            orcaProfiles.settingsProfiles[0],
            options
          );
          bambuOutputDir = fs.mkdtempSync(path.join(this.tempDir, `${operationId}-bambu-output-`));
          // The transformed copy lives in the run's output directory, which is removed afterwards.
          const inputPath = cliInput.meshTransformed ? await this.transformMeshForCli(stlFilePath, options, bambuOutputDir) : stlFilePath;
          args = [...buildBambuCliArgs(bundle, bambuOutputDir, exportName, options, cliInput), inputPath];
          bambuExport = {
            producedPath: path.join(bambuOutputDir, exportName),
            // One folder per operation: concurrent slices of same-named inputs
            // must never replace each other's result before it is printed.
            finalPath: this.operationOutputPath(operationId, exportName),
          };
          outputFilePath = bambuExport.finalPath;
        } catch (error) {
          throw asPreparationError(error, { slicerType, slicerPath });
        }
      } else {
        switch (slicerType) {
          case 'prusaslicer':
          case 'slic3r': { // PrusaSlicer and Slic3r share similar CLI args
            // A filament preset (.ini from the slicer's filament folder) is loaded after the main
            // config: --load may repeat, and later files override earlier ones.
            const filaments = this.splitProfileList(filamentProfile);
            if (filaments.length > 1) {
              throw new SlicerError('preparation',
                `${slicerType} takes one filament preset; filament_profile/FILAMENT_PROFILE lists ${filaments.length}.`, { slicerType, slicerPath });
            }
            if (filaments.length && !/\.ini$/i.test(filaments[0])) {
              throw new SlicerError('preparation',
                `${slicerType} loads filament presets as .ini files (its filament folder, or File > Export > Export Config); ${path.basename(filaments[0])} is not one.`,
                { slicerType, slicerPath });
            }
            args = [
              '--slice',
              '--output', outputFilePath,
              ...(slicerProfile ? ['--load', slicerProfile] : []),
              ...filaments.flatMap((filament) => ['--load', filament]),
              ...prusaSlicerOverrideArgs(processOverrides, slicerProfile ? [slicerProfile] : []),
              ...prusaSlicerPlainGcodeArgs(slicerType, [...(slicerProfile ? [slicerProfile] : []), ...filaments]),
              stlFilePath
            ];
            break;
          }

          case 'orcaslicer':
            orcaOutputDir = path.join(this.tempDir, `${operationId}-orca-output`);
            fs.mkdirSync(orcaOutputDir, { recursive: true });
            args = [
              '--slice', '0',
              '--outputdir', orcaOutputDir,
            ];
            this.appendOrcaProfileArgs(args, await this.withFlattenedOrcaFilaments(
              this.withOrcaProcessOverrides(orcaProfiles, processOverrides, orcaOutputDir), slicerPath, orcaOutputDir));
            args.push(stlFilePath);
            break;

          case 'cura':
            if (Object.keys(orcaProcessOverrides(processOverrides)).length) {
              throw new SlicerError('preparation',
                'quality, strength, layer_height, wall_loops, sparse_infill_density and the support settings are not mapped for Cura; set them in the Cura definition passed as slicer_profile.',
                { slicerType, slicerPath });
            }
            // CuraEngine CLI args are different, often requiring -s for settings
            // Example: curaengine slice -v -j cura_settings.json -s layer_height=0.2 -o output.gcode -l input.stl
            args = [
              'slice',
              '-l', stlFilePath,
              '-o', outputFilePath
            ];
            if (slicerProfile) {
              args.push('-j', slicerProfile); // Load settings from profile definition file
            }
            break;

          default:
            throw new SlicerError('preparation', `Unsupported slicer type: ${slicerType}`, { slicerType, slicerPath });
        }
      }

      // Never mistake a previous run's file for this run's result (or overwrite the input).
      if (path.resolve(outputFilePath) === path.resolve(stlFilePath)) {
        throw new SlicerError('preparation', `Slicer output would overwrite the input file: ${stlFilePath}`, { slicerType, slicerPath });
      }
      if (fs.existsSync(outputFilePath)) fs.rmSync(outputFilePath, { force: true });

      // The slice, kept for reuse: the same model sliced the same way again is restored, and every check below
      // still runs on it (slice-cache.ts). The CLI routes write into a folder of their own; the others one file.
      const cacheRun = { command: slicerPath, args, outputs: [bambuOutputDir ?? orcaOutputDir ?? outputFilePath] };
      const cacheKey = await sliceCacheKey(cacheRun);
      const restored = !!cacheKey && await restoreSlice(cacheKey, cacheRun);
      if (restored) {
        if (progressCallback) progressCallback(90, 'Reusing the same slice of this model');
        console.error(`Reusing slice ${cacheKey} for: ${slicerPath} ${args.join(' ')}`);
      } else {
        if (progressCallback) progressCallback(20, `Executing slicer: ${slicerPath} ${args.join(' ')}`);
        console.error(`Executing: ${slicerPath} ${args.join(' ')}`);
      }

      const cliOutputDir = bambuOutputDir;
      // A Bambu-compatible CLI runs in a home folder of its own (macOS), and one that waits on a dialog is stopped
      // and reported instead of waiting for the timeout (src/slicer/slicer-launch.ts).
      const launch = restored ? undefined : await prepareSlicerLaunch(slicerType, path.resolve(this.tempDir));
      if (!restored) try {
        await runSlicerProcess({
          command: slicerPath,
          args,
          timeoutMs: this.resolveSlicerTimeoutMs(),
          slicerType,
          isCancelled: () => !this.activeOperations.get(operationId),
          failureReason: cliOutputDir ? (exitCode) => bambuCliFailureReason(exitCode, cliOutputDir) : undefined,
          env: launch?.env,
          stallSeconds: launch?.stallSeconds ?? 0,
        });
      } catch (error) {
        // Keep the CLI's own result.json before the output directory is removed.
        const failedResult = cliOutputDir ? readCliResult(cliOutputDir) : undefined;
        if (failedResult && error instanceof SlicerError) throw new SlicerError(error.phase, error.detail, error.details, failedResult);
        throw error;
      } finally {
        await launch?.cleanup();
      }
      const slicerResult = cliOutputDir ? readCliResult(cliOutputDir) : undefined;
      if (cliOutputDir && !slicerResult) {
        // Older or Linux CLIs may write result.json only for handled errors.
        console.error(`${slicerType} wrote no result.json for this slice, so its own checks are not available.`);
      }
      if (typeof slicerResult?.return_code === "number" && slicerResult.return_code !== 0) {
        throw new SlicerError('execution', `Slicer exited with code 0, but its result.json reports return_code ${slicerResult.return_code}.`,
          { slicerType, slicerPath, exitCode: 0 }, slicerResult);
      }

      if (!this.activeOperations.get(operationId)) {
        throw new SlicerError('execution', 'Slicing operation cancelled after process finished', { slicerType, slicerPath });
      }
      // Kept only once its output has passed the checks, and before it moves out of the slicer's folder.
      const keep = async () => { if (cacheKey && !restored) await keepSlice(cacheKey, cacheRun); };
      try {
        if (bambuExport) {
          if (!fs.existsSync(bambuExport.producedPath)) {
            throw new Error(`Slicer exited successfully but did not write ${bambuExport.producedPath}.`);
          }
          await normalize3mfMetadata(bambuExport.producedPath);
          await assertSlicedProjectOutput(bambuExport.producedPath);
          await keep();
          fs.mkdirSync(path.dirname(bambuExport.finalPath), { recursive: true });
          fs.renameSync(bambuExport.producedPath, bambuExport.finalPath);
        } else if (slicerType === 'orcaslicer') {
          if (!orcaOutputDir) {
            throw new Error("Internal error: OrcaSlicer output directory was not initialized.");
          }
          const orcaGcodePath = this.resolveOrcaGcodeOutput(orcaOutputDir);
          await keep();
          fs.renameSync(orcaGcodePath, outputFilePath);
        }

        if (!fs.existsSync(outputFilePath)) {
          throw new Error(`Slicer finished but output file not found: ${outputFilePath}`);
        }
        if (!bambuExport && isBinaryGcode(outputFilePath)) {
          throw new SlicerError('output', `${slicerType} wrote binary G-code (bgcode), which can't be checked before printing or streamed by OctoPrint. ` +
            `Turn off binary G-code in the slicer config (PrusaSlicer: Printer Settings → General → Firmware → Supports binary G-code) and slice again.`,
            { slicerType, slicerPath });
        }
        if (!bambuExport && slicerType !== 'orcaslicer') await keep();
      } catch (error) {
        if (error instanceof SlicerError) throw error;
        throw new SlicerError('output', error instanceof SlicerError ? error.detail : error instanceof Error ? error.message : String(error), { slicerType, slicerPath }, slicerResult);
      }

      if (progressCallback) progressCallback(100, "Slicing completed successfully");

      this.emit('operationComplete', {
        operationId,
        type: 'slice',
        success: true,
        output: outputFilePath
      });

      return slicerResult ? { path: outputFilePath, slicer_result: slicerResult } : { path: outputFilePath };
    } catch (error) {
      console.error(`Slicing failed for ${stlFilePath}:`, error instanceof Error ? error.message : error);
      this.emit('operationError', {
        operationId,
        type: 'slice',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      for (const dir of [orcaOutputDir, bambuOutputDir]) {
        if (dir && fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Enhanced version of confirmTemperatures with better error handling
   * @param gcodePath Path to the G-code file
   * @param expected Expected temperature settings
   * @param progressCallback Optional callback for progress updates
   * @returns Object with comparison results
   */
  async confirmTemperatures(
    gcodePath: string,
    expected: { 
      extruder?: number; 
      bed?: number; 
    },
    progressCallback?: ProgressCallback
  ): Promise<{
    match: boolean;
    actual: { extruder?: number; bed?: number };
    peak: { extruder?: number; bed?: number };
    expected: { extruder?: number; bed?: number };
    allTemperatures: { extruder: number[]; bed: number[] };
  }> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);
    
    try {
      if (progressCallback) progressCallback(0, "Starting temperature verification...");
      
      // Verify the G-code file exists
      if (!fs.existsSync(gcodePath)) {
        throw new Error(`G-code file not found: ${gcodePath}`);
      }
      
      if (progressCallback) progressCallback(20, "Reading G-code file...");
      
      // Read the G-code file
      const gcode = await readFileAsync(gcodePath, 'utf8');
      
      if (!this.activeOperations.get(operationId)) {
        throw new Error("Operation cancelled");
      }
      
      if (progressCallback) progressCallback(50, "Analyzing temperature commands...");
      
      // Extract every heater target with the shared print-safety scanner: S and
      // R forms, tool-addressed commands, RepRapFirmware G10/M568 and Klipper
      // SET_HEATER_TEMPERATURE. Unparseable thermal syntax fails closed.
      const scan = scanGcodeThermal(gcode);
      const allTemperatures: { extruder: number[]; bed: number[] } = {
        extruder: scan.targets.filter((target) => target.heater === "nozzle").map((target) => target.value),
        bed: scan.targets.filter((target) => target.heater === "bed").map((target) => target.value),
      };
      // First positive target, kept for compatibility with the original report.
      const actual: { extruder?: number; bed?: number } = {
        extruder: allTemperatures.extruder.find((value) => value > 0),
        bed: allTemperatures.bed.find((value) => value > 0),
      };
      const peak = {
        extruder: allTemperatures.extruder.length ? Math.max(...allTemperatures.extruder) : undefined,
        bed: allTemperatures.bed.length ? Math.max(...allTemperatures.bed) : undefined,
      };

      if (progressCallback) progressCallback(80, "Comparing temperatures...");

      // An expected temperature matches only when it is the job's highest
      // target, so a later or R-form higher target is always a mismatch.
      let match = true;
      if (expected.extruder !== undefined && peak.extruder !== expected.extruder) {
        match = false;
      }
      if (expected.bed !== undefined && peak.bed !== expected.bed) {
        match = false;
      }

      if (progressCallback) progressCallback(100, "Temperature verification complete");

      this.emit('operationComplete', {
        operationId,
        type: 'confirmTemperatures',
        success: true,
        result: { match, actual, peak, expected, allTemperatures }
      });

      return { match, actual, peak, expected, allTemperatures };
    } catch (error) {
      console.error("Error confirming temperatures:", error);
      
      this.emit('operationError', {
        operationId,
        type: 'confirmTemperatures',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw new Error(`Failed to confirm temperatures: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Merge vertices within a specified tolerance.
   */
  async mergeVertices(
    stlFilePath: string,
    tolerance: number = 0.01, // Default tolerance in mm
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);

    try {
      if (progressCallback) progressCallback(0, "Starting vertex merging...");
      
      const { geometry } = await this.loadSTL(stlFilePath, progressCallback); // 10-50% progress

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(60, "Merging vertices...");

      const originalVertexCount = geometry.attributes.position.count;
      const mergedGeometry = BufferGeometryUtils.mergeVertices(geometry, tolerance);
      const newVertexCount = mergedGeometry.attributes.position.count;

      console.error(`Merged vertices: ${originalVertexCount} -> ${newVertexCount} (Tolerance: ${tolerance}mm)`);
      if (progressCallback) progressCallback(70, `Vertices merged: ${originalVertexCount} -> ${newVertexCount}`);

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");

      const outputFileName = path.basename(stlFilePath, '.stl') + '_merged.stl';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);

      await this.saveSTL(mergedGeometry, outputFilePath, progressCallback); // 80-100% progress

      this.emit('operationComplete', { operationId, type: 'mergeVertices', success: true, output: outputFilePath, verticesRemoved: originalVertexCount - newVertexCount });
      return outputFilePath;

    } catch (error) {
      this.emit('operationError', { operationId, type: 'mergeVertices', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Center the model at the origin (0,0,0).
   */
  async centerModel(
    stlFilePath: string,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);

    try {
      if (progressCallback) progressCallback(0, "Starting centering operation...");
      
      const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback); // 10-50% progress

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(60, "Calculating center...");

      const center = new THREE.Vector3();
      boundingBox.getCenter(center);

      if (center.lengthSq() < 0.0001) { // Already centered (or very close)
          if (progressCallback) progressCallback(100, "Model is already centered.");
          console.error("Model already centered. No changes made.");
          this.emit('operationComplete', { operationId, type: 'centerModel', success: true, output: stlFilePath, message: "Model already centered." });
          return stlFilePath; // Return original path
      }

      if (progressCallback) progressCallback(70, `Applying translation: (${-center.x.toFixed(2)}, ${-center.y.toFixed(2)}, ${-center.z.toFixed(2)})`);

      const translationMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      geometry.applyMatrix4(translationMatrix);
      geometry.computeBoundingBox(); // Recompute bounds after moving

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");

      const outputFileName = path.basename(stlFilePath, '.stl') + '_centered.stl';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);

      await this.saveSTL(geometry, outputFilePath, progressCallback); // 80-100% progress

      this.emit('operationComplete', { operationId, type: 'centerModel', success: true, output: outputFilePath });
      return outputFilePath;

    } catch (error) {
      this.emit('operationError', { operationId, type: 'centerModel', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /**
   * Rotate the model so a face rests on the bed, in the pose with the least
   * part and support material per mm² of bed contact, then move it down to
   * Z=0. Returns the new file's path, or the input path when no pose qualifies.
   */
  async layFlat(
    stlFilePath: string,
    progressCallback?: ProgressCallback
  ): Promise<string> {
    return (await this.layFlatWithResult(stlFilePath, progressCallback)).path;
  }

  /**
   * layFlat with its outcome. A pose qualifies only when some face, turned to
   * face down, lies on the rotated mesh's lowest plane; `laid_flat` is false
   * and the model is unchanged when none does.
   */
  async layFlatWithResult(
    stlFilePath: string,
    progressCallback?: ProgressCallback
  ): Promise<LayFlatResult> {
    const operationId = this.generateOperationId();
    this.activeOperations.set(operationId, true);

    try {
      if (progressCallback) progressCallback(0, "Starting lay flat operation...");

      const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback); // 10-50%

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(55, "Analyzing faces...");

      const positionAttribute = geometry.getAttribute('position');
      if (!positionAttribute) throw new Error("Geometry has no position attribute.");

      const faceCount = Math.floor(positionAttribute.count / 3);
      if (faceCount === 0) throw new Error("No faces found in geometry.");
      const mesh: LayFlatMesh = {
        positions: new Float64Array(faceCount * 9),
        normals: new Float64Array(faceCount * 3),
        areas: new Float64Array(faceCount),
        volume: 0,
      };
      const center = new THREE.Vector3();
      boundingBox.getCenter(center);
      const vA = new THREE.Vector3();
      const vB = new THREE.Vector3();
      const vC = new THREE.Vector3();
      const cb = new THREE.Vector3(), ab = new THREE.Vector3();
      const fromA = new THREE.Vector3(), fromB = new THREE.Vector3(), fromC = new THREE.Vector3();

      for (let face = 0; face < faceCount; face++) {
          vA.fromBufferAttribute(positionAttribute, face * 3);
          vB.fromBufferAttribute(positionAttribute, face * 3 + 1);
          vC.fromBufferAttribute(positionAttribute, face * 3 + 2);
          vA.toArray(mesh.positions, face * 9);
          vB.toArray(mesh.positions, face * 9 + 3);
          vC.toArray(mesh.positions, face * 9 + 6);
          // Signed tetrahedron volumes about the center sum to the enclosed volume.
          fromA.subVectors(vA, center);
          fromB.subVectors(vB, center);
          fromC.subVectors(vC, center);
          mesh.volume += fromA.dot(fromB.cross(fromC)) / 6;

          // The cross product's direction is the outward normal; half its length is the area.
          cb.subVectors(vC, vB);
          ab.subVectors(vA, vB);
          cb.cross(ab);
          mesh.areas[face] = cb.length() / 2;
          cb.normalize().toArray(mesh.normals, face * 3);
      }

      mesh.volume = Math.abs(mesh.volume);

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(65, "Grouping faces by normal...");

      // Group faces by similar normal vectors (tolerance for floating point errors)
      const normalGroups: { totalArea: number; representativeNormal: THREE.Vector3 }[] = [];
      const tolerance = 1e-5;
      const faceNormal = new THREE.Vector3();

      for (let face = 0; face < faceCount; face++) {
          if (!(mesh.areas[face] > 0)) continue;
          faceNormal.fromArray(mesh.normals, face * 3);
          const group = normalGroups.find(candidate => faceNormal.distanceToSquared(candidate.representativeNormal) < tolerance);
          if (group) group.totalArea += mesh.areas[face];
          else normalGroups.push({ totalArea: mesh.areas[face], representativeNormal: faceNormal.clone() });
      }

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");
      if (progressCallback) progressCallback(75, "Finding the pose that rests on the bed...");

      // Candidate directions to turn down: the largest face groups, plus the
      // model's own axes so a part with a domed side can be flipped exactly.
      const candidates = normalGroups
        .sort((a, b) => b.totalArea - a.totalArea)
        .slice(0, LAY_FLAT_MAX_GROUP_CANDIDATES)
        .map(group => group.representativeNormal);
      for (const axis of [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
          const normal = new THREE.Vector3(axis[0], axis[1], axis[2]);
          if (!candidates.some(candidate => candidate.distanceToSquared(normal) < tolerance)) candidates.push(normal);
      }

      let best: LayFlatPose | null = null;
      for (const normal of candidates) {
          const pose = evaluateLayFlatPose(mesh, normal);
          if (pose && (!best || isBetterLayFlatPose(pose, best))) best = pose;
      }

      if (!best) {
          const message = "No face lies on the model's lowest plane in any candidate orientation, so the model is unchanged.";
          console.error(`lay_flat: ${message}`);
          this.emit('operationComplete', { operationId, type: 'layFlat', success: true, output: stlFilePath, message });
          return { path: stlFilePath, laid_flat: false, message };
      }

      if (progressCallback) progressCallback(80, "Calculating rotation...");

      // Turn the chosen normal to face straight down. Turning +Z down rotates
      // half a turn about X, which keeps the model's X layout.
      const downVector = new THREE.Vector3(0, 0, -1);
      const rotationMatrix = best.normal.dot(downVector) < -1 + 1e-9
        ? new THREE.Matrix4().makeRotationX(Math.PI)
        : new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(best.normal, downVector));

      // Rotate around the model's center
      const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
      const fromOriginMatrix = new THREE.Matrix4().makeTranslation(center.x, center.y, center.z);

      // Apply rotation
      geometry.applyMatrix4(toOriginMatrix);
      geometry.applyMatrix4(rotationMatrix);
      geometry.applyMatrix4(fromOriginMatrix);

      // Translate so the new bottom is at Z=0
      geometry.computeBoundingBox(); // Recompute bounds after rotation
      const newMinZ = geometry.boundingBox!.min.z;
      const translateToZeroMatrix = new THREE.Matrix4().makeTranslation(0, 0, -newMinZ);
      geometry.applyMatrix4(translateToZeroMatrix);
      geometry.computeBoundingBox(); // Final bounds

      if (!this.activeOperations.get(operationId)) throw new Error("Operation cancelled");

      const outputFileName = path.basename(stlFilePath, '.stl') + '_flat.stl';
      const outputFilePath = this.operationOutputPath(operationId, outputFileName);

      await this.saveSTL(geometry, outputFilePath, progressCallback); // 90-100% progress

      const message = `Rests on ${best.contactArea.toFixed(1)} mm² of bed contact; overhangs more than 45° from vertical need about ${best.supportVolume.toFixed(0)} mm³ of support.`;
      this.emit('operationComplete', { operationId, type: 'layFlat', success: true, output: outputFilePath, message });
      return { path: outputFilePath, laid_flat: true, message };

    } catch (error) {
      this.emit('operationError', { operationId, type: 'layFlat', error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.activeOperations.delete(operationId);
    }
  }
}

export type LayFlatResult = {
  /** The laid-flat STL, or the unchanged input when `laid_flat` is false. */
  path: string;
  laid_flat: boolean;
  message: string;
};

/** Face corners (9 per face), outward unit normals (3 per face), areas, and the enclosed volume. */
type LayFlatMesh = { positions: Float64Array; normals: Float64Array; areas: Float64Array; volume: number };

/**
 * A direction to turn down, with the bed contact and support it gives.
 * `stackHeight` is the part and support volume over the contact area: the mean
 * height of material standing on each mm² of bed. Standing a long part on its
 * end, or resting a part on a fin under a wide cap, makes it tall.
 */
type LayFlatPose = { normal: THREE.Vector3; contactArea: number; supportVolume: number; stackHeight: number };

const LAY_FLAT_MAX_GROUP_CANDIDATES = 64;
/** Faces tilted more than 45° from vertical overhang and need support. */
const LAY_FLAT_OVERHANG_COS = Math.SQRT1_2 + 1e-6;

/**
 * Score turning `normal` to face the bed. The bed is the mesh's lowest plane in
 * that pose, its support plane. Faces lying on it, within 0.5% of the model's
 * height there (at most 0.2 mm), are bed contact. Overhanging faces above it
 * need support up from the bed: their projected area times their height.
 * Returns null when no face lies on the bed: turning that normal down would
 * rest the model on an edge or a point, not a face.
 */
function evaluateLayFlatPose(mesh: LayFlatMesh, normal: THREE.Vector3): LayFlatPose | null {
  const { positions, normals, areas } = mesh;
  const nx = normal.x, ny = normal.y, nz = normal.z;
  // Distance along the normal grows toward the bed: the bed is at its maximum.
  let bed = -Infinity, top = Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    const along = positions[index] * nx + positions[index + 1] * ny + positions[index + 2] * nz;
    if (along > bed) bed = along;
    if (along < top) top = along;
  }
  const tolerance = Math.min(0.2, Math.max(0.005 * (bed - top), 1e-4));

  let contactArea = 0;
  let supportVolume = 0;
  for (let face = 0; face < areas.length; face++) {
    const facing = normals[face * 3] * nx + normals[face * 3 + 1] * ny + normals[face * 3 + 2] * nz;
    if (!(facing > 0)) continue;
    const base = face * 9;
    let heightSum = 0, heightMax = 0;
    for (let corner = base; corner < base + 9; corner += 3) {
      const height = bed - (positions[corner] * nx + positions[corner + 1] * ny + positions[corner + 2] * nz);
      heightSum += height;
      if (height > heightMax) heightMax = height;
    }
    if (heightMax <= tolerance) contactArea += areas[face];
    else if (facing > LAY_FLAT_OVERHANG_COS) supportVolume += areas[face] * facing * (heightSum / 3);
  }
  if (!(contactArea > 0)) return null;
  return { normal, contactArea, supportVolume, stackHeight: (mesh.volume + supportVolume) / contactArea };
}

/**
 * Prefer the pose with the lowest stack height, then the larger contact. On a
 * tie, keep the face that already points down so a seated part is not flipped.
 */
function isBetterLayFlatPose(pose: LayFlatPose, best: LayFlatPose): boolean {
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
  if (!same(pose.stackHeight, best.stackHeight)) return pose.stackHeight < best.stackHeight;
  if (!same(pose.contactArea, best.contactArea)) return pose.contactArea > best.contactArea;
  return pose.normal.z < best.normal.z;
}
