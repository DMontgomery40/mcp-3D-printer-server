import * as THREE from 'three';
import { EventEmitter } from 'events';
export type ProgressCallback = (progress: number, message?: string) => void;
export type OperationResult = {
    success: boolean;
    filePath?: string;
    error?: string;
    operationId: string;
};
export type TransformationType = 'scale' | 'rotate' | 'translate' | 'extendBase' | 'customModify';
export type TransformationAxis = 'x' | 'y' | 'z' | 'all';
export type BoundingBox = {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    dimensions: THREE.Vector3;
};
export type TransformationParams = {
    type: TransformationType;
    axis?: TransformationAxis;
    value: number | number[];
    relative?: boolean;
    selectionBounds?: THREE.Box3;
};
export declare class STLManipulator extends EventEmitter {
    private tempDir;
    private activeOperations;
    constructor(tempDir?: string);
    /**
     * Generate a unique operation ID
     */
    private generateOperationId;
    /**
     * Load STL file and return geometry and bounding box
     */
    private loadSTL;
    /**
     * Save a geometry to STL file
     */
    private saveSTL;
    /**
     * Get comprehensive information about an STL file
     */
    getSTLInfo(stlFilePath: string): Promise<{
        filePath: string;
        fileName: string;
        fileSize: number;
        boundingBox: BoundingBox;
        vertexCount: number;
        faceCount: number;
    }>;
    /**
     * Scale an STL model uniformly or along specific axes
     */
    scaleSTL(stlFilePath: string, scaleFactors: number | [number, number, number], progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Rotate an STL model around specific axes
     */
    rotateSTL(stlFilePath: string, rotationAngles: [number, number, number], // [x, y, z] in degrees
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Translate (move) an STL model along specific axes
     */
    translateSTL(stlFilePath: string, translationValues: [number, number, number], // [x, y, z] in mm
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Cancel an ongoing operation
     */
    cancelOperation(operationId: string): boolean;
    /**
     * Generate an SVG visualization of an STL file from multiple angles
     * @param stlFilePath Path to the STL file
     * @param width Width of each view in pixels
     * @param height Height of each view in pixels
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the generated SVG file
     */
    generateVisualization(stlFilePath: string, width?: number, height?: number, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Apply a specific transformation to a selected section of an STL file
     * This allows for targeted modifications of specific parts of a model
     */
    modifySection(stlFilePath: string, selection: THREE.Box3 | 'top' | 'bottom' | 'center', transformation: TransformationParams, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Enhanced version of extendBase with progress reporting
     * @param stlFilePath Path to the input STL file
     * @param extensionInches Amount to extend base in inches
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the modified STL file
     */
    extendBase(stlFilePath: string, extensionInches: number, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Slice an STL file using the specified slicer
     * @param stlFilePath Path to the input STL file
     * @param slicerType Type of slicer (prusaslicer, cura, slic3r, orcaslicer)
     * @param slicerPath Path to the slicer executable
     * @param slicerProfile Optional path to the slicer profile/config file
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the generated G-code file
     */
    sliceSTL(stlFilePath: string, slicerType: 'prusaslicer' | 'cura' | 'slic3r' | 'orcaslicer', slicerPath: string, slicerProfile?: string, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Enhanced version of confirmTemperatures with better error handling
     * @param gcodePath Path to the G-code file
     * @param expected Expected temperature settings
     * @param progressCallback Optional callback for progress updates
     * @returns Object with comparison results
     */
    confirmTemperatures(gcodePath: string, expected: {
        extruder?: number;
        bed?: number;
    }, progressCallback?: ProgressCallback): Promise<{
        match: boolean;
        actual: {
            extruder?: number;
            bed?: number;
        };
        expected: {
            extruder?: number;
            bed?: number;
        };
        allTemperatures: {
            extruder: number[];
            bed: number[];
        };
    }>;
    /**
     * Merge vertices within a specified tolerance.
     */
    mergeVertices(stlFilePath: string, tolerance?: number, // Default tolerance in mm
    progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Center the model at the origin (0,0,0).
     */
    centerModel(stlFilePath: string, progressCallback?: ProgressCallback): Promise<string>;
    /**
     * Rotate the model so its largest flat face lies on the XY plane (Z=0).
     */
    layFlat(stlFilePath: string, progressCallback?: ProgressCallback): Promise<string>;
}
