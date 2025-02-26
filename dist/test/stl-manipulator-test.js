#!/usr/bin/env node
import { STLManipulator } from '../stl/stl-manipulator.js';
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
// Create a test directory
const TEST_DIR = path.join(process.cwd(), 'test');
if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
}
// Path for a sample STL file
const sampleStlPath = path.join(TEST_DIR, 'sample_cube.stl');
// Create a simple cube STL for testing if it doesn't exist
async function createSampleCube() {
    if (fs.existsSync(sampleStlPath)) {
        console.log('Sample STL already exists, skipping creation');
        return sampleStlPath;
    }
    console.log('Creating sample cube STL...');
    // Create a simple cube geometry
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    const material = new THREE.MeshStandardMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    // Import STLExporter
    const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
    const exporter = new STLExporter();
    // Export as STL
    const stlString = exporter.parse(mesh);
    // Write to file
    fs.writeFileSync(sampleStlPath, stlString);
    console.log(`Sample cube saved to ${sampleStlPath}`);
    return sampleStlPath;
}
// Test the STL manipulator
async function testSTLManipulator() {
    try {
        // Create a sample STL for testing
        const stlPath = await createSampleCube();
        // Create an instance of the STL manipulator with the test directory
        const manipulator = new STLManipulator(TEST_DIR);
        // Listen for events from the manipulator
        manipulator.on('operationComplete', (data) => {
            console.log('Operation complete:', data);
        });
        manipulator.on('operationError', (data) => {
            console.error('Operation error:', data);
        });
        // Test progress callback
        const progressCallback = (progress, message) => {
            console.log(`Progress: ${progress}% - ${message || ''}`);
        };
        // Test 1: Get information about the STL file
        console.log('\n=== Test 1: Get STL Info ===');
        const stlInfo = await manipulator.getSTLInfo(stlPath);
        console.log('STL Info:', stlInfo);
        // Test 2: Scale the STL file
        console.log('\n=== Test 2: Scale STL ===');
        const scaledStlPath = await manipulator.scaleSTL(stlPath, 2.0, progressCallback);
        console.log(`Scaled STL saved to: ${scaledStlPath}`);
        // Test 3: Rotate the STL file
        console.log('\n=== Test 3: Rotate STL ===');
        const rotatedStlPath = await manipulator.rotateSTL(stlPath, [45, 0, 0], progressCallback);
        console.log(`Rotated STL saved to: ${rotatedStlPath}`);
        // Test 4: Translate the STL file
        console.log('\n=== Test 4: Translate STL ===');
        const translatedStlPath = await manipulator.translateSTL(stlPath, [5, 10, 0], progressCallback);
        console.log(`Translated STL saved to: ${translatedStlPath}`);
        // Test 5: Extend the base of the STL file
        console.log('\n=== Test 5: Extend Base ===');
        const extendedStlPath = await manipulator.extendBase(stlPath, 0.5, progressCallback);
        console.log(`Extended STL saved to: ${extendedStlPath}`);
        // Test 6: Modify a section of the STL file
        console.log('\n=== Test 6: Modify Section (Top) ===');
        const modifiedStlPath = await manipulator.modifySection(stlPath, 'top', {
            type: 'scale',
            value: [1.5, 1.5, 1.5]
        }, progressCallback);
        console.log(`Modified STL saved to: ${modifiedStlPath}`);
        // Test 7: Generate visualization of the STL file
        console.log('\n=== Test 7: Generate Visualization ===');
        const visualizationPath = await manipulator.generateVisualization(stlPath, 400, 400, progressCallback);
        console.log(`Visualization saved to: ${visualizationPath}`);
        console.log('\nAll tests completed successfully!');
    }
    catch (error) {
        console.error('An error occurred during testing:', error);
        process.exit(1);
    }
}
// Run the tests
testSTLManipulator().catch(console.error);
