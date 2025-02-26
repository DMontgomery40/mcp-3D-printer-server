import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
export class STLManipulator extends EventEmitter {
    constructor(tempDir = path.join(process.cwd(), 'temp')) {
        super();
        this.activeOperations = new Map();
        this.tempDir = tempDir;
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }
    /**
     * Generate a unique operation ID
     */
    generateOperationId() {
        return crypto.randomUUID();
    }
    /**
     * Load STL file and return geometry and bounding box
     */
    async loadSTL(stlFilePath, progressCallback) {
        try {
            if (progressCallback)
                progressCallback(10, "Loading STL file...");
            // Read the STL file
            const stlData = await readFileAsync(stlFilePath);
            if (progressCallback)
                progressCallback(30, "Parsing STL data...");
            // Load the STL data into a Three.js geometry
            const loader = new STLLoader();
            const geometry = loader.parse(stlData.buffer);
            // Create a mesh from the geometry
            const material = new THREE.MeshStandardMaterial();
            const mesh = new THREE.Mesh(geometry, material);
            // Compute the bounding box
            geometry.computeBoundingBox();
            const boundingBox = geometry.boundingBox;
            if (progressCallback)
                progressCallback(50, "STL loaded successfully");
            return { geometry, boundingBox, mesh };
        }
        catch (error) {
            console.error("Error loading STL file:", error);
            throw new Error(`Failed to load STL file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Save a geometry to STL file
     */
    async saveSTL(geometry, outputFilePath, progressCallback) {
        try {
            if (progressCallback)
                progressCallback(80, "Exporting to STL...");
            // Create mesh for export
            const material = new THREE.MeshStandardMaterial();
            const mesh = new THREE.Mesh(geometry, material);
            // Export the mesh as STL
            const exporter = new STLExporter();
            const stlString = exporter.parse(mesh);
            // Write the STL to file
            await writeFileAsync(outputFilePath, stlString);
            if (progressCallback)
                progressCallback(100, "STL saved successfully");
            return outputFilePath;
        }
        catch (error) {
            console.error("Error saving STL file:", error);
            throw new Error(`Failed to save STL file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Get comprehensive information about an STL file
     */
    async getSTLInfo(stlFilePath) {
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
        }
        catch (error) {
            console.error("Error getting STL info:", error);
            throw new Error(`Failed to get STL info: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Scale an STL model uniformly or along specific axes
     */
    async scaleSTL(stlFilePath, scaleFactors, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting scaling operation...");
            // Load the STL file
            const { geometry, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying scaling transformation...");
            // Apply scaling
            let scaleX, scaleY, scaleZ;
            if (typeof scaleFactors === 'number') {
                // Uniform scaling
                scaleX = scaleY = scaleZ = scaleFactors;
            }
            else {
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
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'scale',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'scale',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Rotate an STL model around specific axes
     */
    async rotateSTL(stlFilePath, rotationAngles, // [x, y, z] in degrees
    progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting rotation operation...");
            // Load the STL file
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying rotation transformation...");
            // Convert degrees to radians
            const [rotX, rotY, rotZ] = rotationAngles.map(angle => angle * Math.PI / 180);
            // Get the center of the model
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            // Create translation matrices to rotate around the center
            const toOriginMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
            const rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'XYZ'));
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
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'rotate',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'rotate',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Translate (move) an STL model along specific axes
     */
    async translateSTL(stlFilePath, translationValues, // [x, y, z] in mm
    progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting translation operation...");
            // Load the STL file
            const { geometry } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Applying translation transformation...");
            // Apply translation
            const [translateX, translateY, translateZ] = translationValues;
            const translationMatrix = new THREE.Matrix4().makeTranslation(translateX, translateY, translateZ);
            geometry.applyMatrix4(translationMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_translated.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'translate',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'translate',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Cancel an ongoing operation
     */
    cancelOperation(operationId) {
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
    async generateVisualization(stlFilePath, width = 300, height = 300, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting visualization generation...");
            // Load the STL file
            const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(50, "Setting up 3D scene...");
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
            if (progressCallback)
                progressCallback(60, "Generating SVG representation...");
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
            <rect x="${-cubeSize / 2}" y="${-cubeSize / 2}" width="${cubeSize}" height="${cubeSize}" 
                  style="fill:#e0e0e0;stroke:#000;stroke-width:1;opacity:0.8;${view.transform}" />
            <text x="0" y="${cubeSize / 2 + 30}" text-anchor="middle" font-family="Arial" font-size="12" fill="black">
              ${view.name}
            </text>
          </g>
        `;
                if (progressCallback)
                    progressCallback(60 + (i + 1) * 10, `Generated ${view.name} view`);
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
            if (progressCallback)
                progressCallback(90, "Visualization generated");
            if (progressCallback)
                progressCallback(90, "Saving visualization...");
            // Write the SVG to file
            const outputFileName = path.basename(stlFilePath, '.stl') + '_visualization.svg';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            await writeFileAsync(outputFilePath, svgContent);
            if (progressCallback)
                progressCallback(100, "Visualization saved successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'visualization',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            console.error("Error generating visualization:", error);
            this.emit('operationError', {
                operationId,
                type: 'visualization',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to generate visualization: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Apply a specific transformation to a selected section of an STL file
     * This allows for targeted modifications of specific parts of a model
     */
    async modifySection(stlFilePath, selection, transformation, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting section modification...");
            // Load the STL file
            const { geometry, boundingBox, mesh } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(40, "Identifying section to modify...");
            // Convert named sections to actual bounding boxes
            let selectionBox;
            if (selection === 'top') {
                // Select top third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const topThreshold = boundingBox.max.y - (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, topThreshold, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, boundingBox.max.y, boundingBox.max.z));
            }
            else if (selection === 'bottom') {
                // Select bottom third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const bottomThreshold = boundingBox.min.y + (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, boundingBox.min.y, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, bottomThreshold, boundingBox.max.z));
            }
            else if (selection === 'center') {
                // Select middle third of the model
                const height = boundingBox.max.y - boundingBox.min.y;
                const bottomThreshold = boundingBox.min.y + (height / 3);
                const topThreshold = boundingBox.max.y - (height / 3);
                selectionBox = new THREE.Box3(new THREE.Vector3(boundingBox.min.x, bottomThreshold, boundingBox.min.z), new THREE.Vector3(boundingBox.max.x, topThreshold, boundingBox.max.z));
            }
            else {
                // Use the provided bounding box
                selectionBox = selection;
            }
            if (progressCallback)
                progressCallback(50, "Applying transformation to selected section...");
            // Get position attribute for direct manipulation
            const positionAttribute = geometry.getAttribute('position');
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
                        transformMatrix = new THREE.Matrix4().makeScale(transformation.value, transformation.value, transformation.value);
                    }
                    else {
                        const [scaleX, scaleY, scaleZ] = transformation.value;
                        transformMatrix = new THREE.Matrix4().makeScale(scaleX, scaleY, scaleZ);
                    }
                    break;
                case 'rotate':
                    const rotValues = (typeof transformation.value === 'number')
                        ? [0, 0, transformation.value * Math.PI / 180]
                        : transformation.value.map(v => v * Math.PI / 180);
                    transformMatrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotValues[0], rotValues[1], rotValues[2], 'XYZ'));
                    break;
                case 'translate':
                    if (typeof transformation.value === 'number') {
                        const translateValue = transformation.value;
                        transformMatrix = new THREE.Matrix4().makeTranslation(translateValue, translateValue, translateValue);
                    }
                    else {
                        const [transX, transY, transZ] = transformation.value;
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
            }
            catch (error) {
                console.error("Error modifying vertices:", error);
                throw new Error(`Failed to modify section: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Generate output file path
            const outputFileName = path.basename(stlFilePath, '.stl') + '_modified.stl';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            // Save the modified STL
            await this.saveSTL(geometry, outputFilePath, progressCallback);
            this.emit('operationComplete', {
                operationId,
                type: 'modifySection',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            this.emit('operationError', {
                operationId,
                type: 'modifySection',
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
        finally {
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
    async extendBase(stlFilePath, extensionInches, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting base extension operation...");
            console.log(`Extending base of ${stlFilePath} by ${extensionInches} inches`);
            // Load the STL file
            const { geometry, boundingBox } = await this.loadSTL(stlFilePath, progressCallback);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(60, "Creating extended base geometry...");
            // Find the minimum Y value (assuming Y is up, which is common in 3D printing)
            const minY = boundingBox.min.y;
            // Convert inches to millimeters (STL files typically use mm)
            const extensionMm = extensionInches * 25.4;
            // Create a transformation matrix to move the mesh up by the extension amount
            const matrix = new THREE.Matrix4().makeTranslation(0, extensionMm, 0);
            geometry.applyMatrix4(matrix);
            // Create a box geometry for the base extension
            const baseWidth = boundingBox.max.x - boundingBox.min.x;
            const baseDepth = boundingBox.max.z - boundingBox.min.z;
            const baseGeometry = new THREE.BoxGeometry(baseWidth, extensionMm, baseDepth);
            // Position the base geometry
            const baseMatrix = new THREE.Matrix4().makeTranslation((boundingBox.min.x + boundingBox.max.x) / 2, minY + extensionMm / 2, (boundingBox.min.z + boundingBox.max.z) / 2);
            baseGeometry.applyMatrix4(baseMatrix);
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(70, "Merging geometries...");
            if (progressCallback)
                progressCallback(75, "Creating merged geometry...");
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
            const outputFilePath = path.join(this.tempDir, outputFileName);
            if (progressCallback)
                progressCallback(90, "Saving extended STL...");
            // Write the combined STL data to file
            await writeFileAsync(outputFilePath, originalStl + baseStl);
            if (progressCallback)
                progressCallback(100, "STL saved successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'extendBase',
                success: true,
                output: outputFilePath
            });
            console.log(`Modified STL saved to ${outputFilePath}`);
            return outputFilePath;
        }
        catch (error) {
            console.error("Error extending STL base:", error);
            this.emit('operationError', {
                operationId,
                type: 'extendBase',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to extend STL base: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
    /**
     * Enhanced version of sliceSTL with progress reporting and error handling
     * @param stlFilePath Path to the STL file
     * @param slicerType Type of slicer to use ('prusaslicer', 'cura', 'slic3r')
     * @param slicerPath Path to the slicer executable
     * @param slicerProfile Profile to use for slicing
     * @param progressCallback Optional callback for progress updates
     * @returns Path to the generated G-code file
     */
    async sliceSTL(stlFilePath, slicerType, slicerPath, slicerProfile, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting slicing operation...");
            const { exec } = require('child_process');
            const execAsync = promisify(exec);
            // Verify the STL file exists
            if (!fs.existsSync(stlFilePath)) {
                throw new Error(`STL file not found: ${stlFilePath}`);
            }
            // Verify the slicer executable exists if provided
            if (slicerPath && !fs.existsSync(slicerPath)) {
                throw new Error(`Slicer executable not found: ${slicerPath}`);
            }
            if (progressCallback)
                progressCallback(10, "Preparing slicing command...");
            const outputFileName = path.basename(stlFilePath, '.stl') + '.gcode';
            const outputFilePath = path.join(this.tempDir, outputFileName);
            let command = '';
            switch (slicerType) {
                case 'prusaslicer':
                    command = `"${slicerPath}" --export-gcode --output "${outputFilePath}"`;
                    if (slicerProfile) {
                        if (!fs.existsSync(slicerProfile)) {
                            console.warn(`Warning: Slicer profile not found: ${slicerProfile}`);
                        }
                        command += ` --load "${slicerProfile}"`;
                    }
                    command += ` "${stlFilePath}"`;
                    break;
                case 'cura':
                    command = `"${slicerPath}" -o "${outputFilePath}"`;
                    if (slicerProfile) {
                        if (!fs.existsSync(slicerProfile)) {
                            console.warn(`Warning: Slicer profile not found: ${slicerProfile}`);
                        }
                        command += ` -l "${slicerProfile}"`;
                    }
                    command += ` "${stlFilePath}"`;
                    break;
                case 'slic3r':
                    command = `"${slicerPath}" --output "${outputFilePath}"`;
                    if (slicerProfile) {
                        if (!fs.existsSync(slicerProfile)) {
                            console.warn(`Warning: Slicer profile not found: ${slicerProfile}`);
                        }
                        command += ` --load "${slicerProfile}"`;
                    }
                    command += ` "${stlFilePath}"`;
                    break;
                default:
                    throw new Error(`Unsupported slicer type: ${slicerType}`);
            }
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(20, "Running slicer...");
            console.log(`Slicing STL with command: ${command}`);
            // Execute the slicing command
            await new Promise((resolve, reject) => {
                const slicerProcess = exec(command);
                // Set up a timeout for the slicing operation (15 minutes)
                const timeout = setTimeout(() => {
                    if (slicerProcess.pid) {
                        process.kill(slicerProcess.pid);
                    }
                    reject(new Error("Slicing operation timed out after 15 minutes"));
                }, 15 * 60 * 1000);
                // Handle stdout data
                slicerProcess.stdout?.on('data', (data) => {
                    console.log(`Slicer stdout: ${data}`);
                    // Attempt to extract progress information (varies by slicer)
                    const progressMatch = data.match(/(\d+)%/);
                    if (progressMatch && progressCallback) {
                        const slicerProgress = parseInt(progressMatch[1], 10);
                        // Map slicer's 0-100% to our 20-90% range
                        const mappedProgress = 20 + (slicerProgress * 0.7);
                        progressCallback(mappedProgress, `Slicing: ${slicerProgress}%`);
                    }
                });
                // Handle stderr data
                slicerProcess.stderr?.on('data', (data) => {
                    console.error(`Slicer stderr: ${data}`);
                });
                // Handle completion
                slicerProcess.on('close', (code) => {
                    clearTimeout(timeout);
                    if (code === 0) {
                        resolve();
                    }
                    else {
                        reject(new Error(`Slicer process exited with code ${code}`));
                    }
                });
                // Handle errors
                slicerProcess.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            // Verify the G-code file was created
            if (!fs.existsSync(outputFilePath)) {
                throw new Error("Slicing failed: G-code file was not created");
            }
            if (progressCallback)
                progressCallback(100, "Slicing completed successfully");
            this.emit('operationComplete', {
                operationId,
                type: 'slice',
                success: true,
                output: outputFilePath
            });
            return outputFilePath;
        }
        catch (error) {
            console.error("Error slicing STL:", error);
            this.emit('operationError', {
                operationId,
                type: 'slice',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to slice STL: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
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
    async confirmTemperatures(gcodePath, expected, progressCallback) {
        const operationId = this.generateOperationId();
        this.activeOperations.set(operationId, true);
        try {
            if (progressCallback)
                progressCallback(0, "Starting temperature verification...");
            // Verify the G-code file exists
            if (!fs.existsSync(gcodePath)) {
                throw new Error(`G-code file not found: ${gcodePath}`);
            }
            if (progressCallback)
                progressCallback(20, "Reading G-code file...");
            // Read the G-code file
            const gcode = await readFileAsync(gcodePath, 'utf8');
            const lines = gcode.split('\n');
            if (!this.activeOperations.get(operationId)) {
                throw new Error("Operation cancelled");
            }
            if (progressCallback)
                progressCallback(50, "Analyzing temperature commands...");
            // Extract temperature settings from G-code
            const actual = {};
            const allTemperatures = { extruder: [], bed: [] };
            for (const line of lines) {
                // Look for extruder temperature (M104 or M109)
                const extruderMatch = line.match(/M10[49] S(\d+)/);
                if (extruderMatch) {
                    const temp = parseInt(extruderMatch[1], 10);
                    allTemperatures.extruder.push(temp);
                    // Keep the first temperature for compatibility with original function
                    if (!actual.extruder) {
                        actual.extruder = temp;
                    }
                }
                // Look for bed temperature (M140 or M190)
                const bedMatch = line.match(/M1[49]0 S(\d+)/);
                if (bedMatch) {
                    const temp = parseInt(bedMatch[1], 10);
                    allTemperatures.bed.push(temp);
                    // Keep the first temperature for compatibility with original function
                    if (!actual.bed) {
                        actual.bed = temp;
                    }
                }
            }
            if (progressCallback)
                progressCallback(80, "Comparing temperatures...");
            // Compare actual with expected
            let match = true;
            if (expected.extruder !== undefined && actual.extruder !== expected.extruder) {
                match = false;
            }
            if (expected.bed !== undefined && actual.bed !== expected.bed) {
                match = false;
            }
            if (progressCallback)
                progressCallback(100, "Temperature verification complete");
            this.emit('operationComplete', {
                operationId,
                type: 'confirmTemperatures',
                success: true,
                result: { match, actual, expected, allTemperatures }
            });
            return { match, actual, expected, allTemperatures };
        }
        catch (error) {
            console.error("Error confirming temperatures:", error);
            this.emit('operationError', {
                operationId,
                type: 'confirmTemperatures',
                error: error instanceof Error ? error.message : String(error)
            });
            throw new Error(`Failed to confirm temperatures: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            this.activeOperations.delete(operationId);
        }
    }
}
