import JSZip from 'jszip';
import { parseStringPromise } from 'xml2js';
import { ThreeMFData, BambuSlicerConfig, ThreeMFMetadata, ThreeMFObject, ThreeMFBuildItem, AMSFilamentMapping, ThreeMFPlateObjects } from './types.js';
import * as fs from 'fs/promises';

// Parses Bambu Studio's JSON config data
function parseBambuJSONConfig(jsonData: any): Partial<BambuSlicerConfig> {
    const config: Partial<BambuSlicerConfig> = {};
    const amsMapping: AMSFilamentMapping = {};

    // Map known keys, converting types as needed
    if (jsonData.layer_height !== undefined) config.layer_height = parseFloat(jsonData.layer_height);
    if (jsonData.initial_layer_print_height !== undefined) config.first_layer_height = parseFloat(jsonData.initial_layer_print_height);
    if (jsonData.sparse_infill_density !== undefined) config.sparse_infill_density = parseFloat(jsonData.sparse_infill_density);
    if (jsonData.sparse_infill_pattern !== undefined) config.sparse_infill_pattern = String(jsonData.sparse_infill_pattern);
    if (jsonData.enable_support !== undefined) config.support_enabled = String(jsonData.enable_support) === '1' || String(jsonData.enable_support).toLowerCase() === 'true';
    if (jsonData.support_type !== undefined) config.support_type = String(jsonData.support_type);
    if (jsonData.support_angle !== undefined) config.support_threshold_angle = parseFloat(jsonData.support_angle);
    if (jsonData.raft_layers !== undefined) config.raft_layers = parseInt(String(jsonData.raft_layers), 10);
    if (jsonData.brim_width !== undefined) config.brim_width = parseFloat(jsonData.brim_width);
    if (jsonData.wall_loops !== undefined) config.wall_loops = parseInt(String(jsonData.wall_loops), 10);
    if (jsonData.top_shell_layers !== undefined) config.top_shell_layers = parseInt(String(jsonData.top_shell_layers), 10);
    if (jsonData.bottom_shell_layers !== undefined) config.bottom_shell_layers = parseInt(String(jsonData.bottom_shell_layers), 10);

    // Temperatures (handle potential arrays)
    if (Array.isArray(jsonData.nozzle_temperature) && jsonData.nozzle_temperature.length > 0) {
        config.nozzle_temperature = jsonData.nozzle_temperature.map((t: string | number) => parseFloat(String(t)));
    } else if (jsonData.nozzle_temperature !== undefined) {
         config.nozzle_temperature = [parseFloat(String(jsonData.nozzle_temperature))];
    }
    // Bed Temp (prefer initial layer temp)
    let bedTempKey = jsonData.hot_plate_temp_initial_layer !== undefined ? 'hot_plate_temp_initial_layer' : 'hot_plate_temp';
    if (jsonData[bedTempKey] !== undefined) {
         if (Array.isArray(jsonData[bedTempKey]) && jsonData[bedTempKey].length > 0) {
              config.bed_temperature = parseFloat(String(jsonData[bedTempKey][0]));
         } else {
             config.bed_temperature = parseFloat(String(jsonData[bedTempKey]));
         }
    }
    
    // Filaments and Flow (handle potential arrays)
    if (Array.isArray(jsonData.filament_type) && jsonData.filament_type.length > 0) {
        config.filament_type = jsonData.filament_type.map(String);
    }
    if (Array.isArray(jsonData.filament_flow_ratio) && jsonData.filament_flow_ratio.length > 0) {
        config.flow_ratio = jsonData.filament_flow_ratio.map((f: string | number) => parseFloat(String(f)));
    }

    // AMS Mapping (derive from filament_settings_id order)
    if (Array.isArray(jsonData.filament_settings_id) && jsonData.filament_settings_id.length > 0) {
        jsonData.filament_settings_id.forEach((filamentId: string, index: number) => {
            // Map filament ID (e.g., "Generic PLA @BBL P1P") to its index (assumed AMS slot)
            if (filamentId) { // Ensure filamentId is not empty
                 amsMapping[filamentId] = index;
            }
        });
        if (Object.keys(amsMapping).length > 0) {
             config.ams_mapping = amsMapping;
        }
    }

    // Store remaining keys found in the config
    for (const key in jsonData) {
        if (!config.hasOwnProperty(key)) {
            // Simple assignment for remaining keys, preserving original type if possible
            config[key] = jsonData[key]; 
        }
    }

    return config;
}

/** The files a 3MF's slicer settings are read from, first found wins: Bambu Studio/Orca, then PrusaSlicer. */
export const SLICER_SETTINGS_FILES = [
    'Metadata/project_settings.config',
    'Metadata/Slic3r_PE.config',
    'Metadata/model_settings.config',
    'Metadata/slice_info.config',
];

async function parseBambuConfig(zip: JSZip): Promise<Partial<BambuSlicerConfig>> {
    const potentialFiles = SLICER_SETTINGS_FILES;
    let configFile = null;
    let configContent = '';

    for (const name of potentialFiles) {
        const file = zip.file(name);
        if (file) {
            configFile = file;
            configContent = await file.async('string');
            console.error(`Found Bambu config file: ${configFile.name}`);
            break; // Use the first one found (project usually has the most)
        }
    }

    if (configFile && configContent) {
        try {
            // Attempt to parse as JSON
            const jsonData = JSON.parse(configContent);
            const parsedConfig = parseBambuJSONConfig(jsonData);
            console.error('Bambu config parsed successfully as JSON.');
            return parsedConfig;
        } catch (jsonError: any) {
            console.warn(`Failed to parse ${configFile.name} as JSON: ${jsonError.message}. Attempting INI parse as fallback...`);
            // Fallback: Try parsing as INI if JSON fails (though unlikely based on sample)
            try {
                 const parsedConfig = parseFallbackINIConfig(configContent); // Keep a simple INI parser as fallback
                 console.error('Bambu config parsed successfully as INI (fallback).');
                 return parsedConfig;
            } catch (iniError: any) {
                 console.error(`Error parsing Bambu config ${configFile.name} as INI (fallback):`, iniError);
                 return {};
            }
        }
    } else {
        console.error('No Bambu-specific config file found in Metadata directory.');
        return {};
    }
}

// Fallback INI parser (Simplified version of the previous one)
function parseFallbackINIConfig(configContent: string): Partial<BambuSlicerConfig> {
     const config: Partial<BambuSlicerConfig> = {};
     const lines = configContent.split(/\r?\n/);
     for (const line of lines) {
         const trimmedLine = line.trim();
         if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith(';')) continue;
         const equalsIndex = trimmedLine.indexOf('=');
         if (equalsIndex === -1) continue;
         const key = trimmedLine.substring(0, equalsIndex).trim();
         const value = trimmedLine.substring(equalsIndex + 1).trim();
         // Simple assignment - no type conversion here for fallback
         config[key] = value;
     }
     return config;
 }

async function parse3DModelConfig(zip: JSZip): Promise<{ metadata: ThreeMFMetadata, objects: ThreeMFObject[], build: { items: ThreeMFBuildItem[] } }> {
    const modelFile = zip.file('3D/3dmodel.model');
    if (!modelFile) {
        throw new Error('3D/3dmodel.model not found in 3MF archive');
    }

    const modelContent = await modelFile.async('string');
    try {
        const parsedXml = await parseStringPromise(modelContent, {
            explicitArray: false, 
            mergeAttrs: true,
            charkey: 'value'
        });

        const modelData = parsedXml.model;
        if (!modelData) {
            throw new Error('Invalid 3dmodel.model format: <model> tag not found.');
        }

        const metadata: ThreeMFMetadata = { unit: modelData.unit || 'millimeter' };
        if (modelData.metadata) {
            const metas = Array.isArray(modelData.metadata) ? modelData.metadata : [modelData.metadata];
            metas.forEach((meta: any) => {
                if (meta.name && meta.value !== undefined) {
                    metadata[meta.name] = String(meta.value);
                }
            });
        }

        const objects: ThreeMFObject[] = [];
        if (modelData.resources?.object) {
            const resources = Array.isArray(modelData.resources.object) ? modelData.resources.object : [modelData.resources.object];
            resources.forEach((objResource: any) => {
                objects.push({
                    id: objResource.id, 
                    name: objResource.name,
                    type: objResource.type || 'model'
                    // Actual mesh data (vertices, triangles) is nested deeper if needed
                });
            });
        }

        const buildItems: ThreeMFBuildItem[] = [];
        if (modelData.build?.item) {
            const items = Array.isArray(modelData.build.item) ? modelData.build.item : [modelData.build.item];
            items.forEach((item: any) => {
                buildItems.push({
                    objectId: item.objectid,
                    transform: item.transform
                });
            });
        }

        console.error('3dmodel.model parsed successfully.');
        return { metadata, objects, build: { items: buildItems } };

    } catch (error: any) {
        console.error('Error parsing 3dmodel.model XML:', error);
        throw new Error(`Failed to parse 3dmodel.model: ${error.message}`);
    }
}

export { ThreeMFData };

export async function parse3MF(filePath: string): Promise<ThreeMFData> {
    console.error(`Parsing 3MF file: ${filePath}`);
    try {
        const data = await fs.readFile(filePath);
        const zip = await JSZip.loadAsync(data);

        // List files for debugging
        // const fileList = Object.keys(zip.files);
        // console.error('Files in 3MF:', fileList);

        const { metadata, objects, build } = await parse3DModelConfig(zip);
        const bambuConfig = await parseBambuConfig(zip);

        // Combine data into the final structure
        const combinedData: ThreeMFData = {
            metadata,
            objects,
            build,
            slicerConfig: bambuConfig
        };

        console.error('3MF parsing completed.');
        return combinedData;

    } catch (error: any) {
        console.error(`Error parsing 3MF file ${filePath}:`, error);
        throw new Error(`Failed to parse 3MF file: ${error.message}`);
    }
} 

/**
 * The objects of one sliced plate that the printer can skip, as Bambu Studio lists them in its skip dialog
 * (02.08.02.61 slic3r/GUI/PartSkipDialog.cpp:734-741, SkipPartCanvas.cpp:690-730): one entry per instance
 * from Metadata/slice_info.config's plate whose `index` matches (written per instance at bbs_3mf.cpp:8718-8750),
 * with its identify_id. plate_N.json's bbox_objects are not paired by position: their `id` is an internal
 * object id the printer doesn't know (BambuStudio.cpp:7374-7382), and copies share a name. The wipe tower
 * is never a slice_info object.
 */
export async function analyze3MFPlateObjects(
    filePath: string,
    plateIndex: number = 0
): Promise<ThreeMFPlateObjects> {
    const data = await fs.readFile(filePath);
    const zip = await JSZip.loadAsync(data);
    const plateNumber = plateIndex + 1;
    const sliceInfo = zip.file('Metadata/slice_info.config');
    if (!sliceInfo) {
        throw new Error('This 3MF has no Metadata/slice_info.config, so it was not sliced by Bambu Studio or OrcaSlicer and has no skip-object ids. Slice it first.');
    }
    const parsed = await parseStringPromise(await sliceInfo.async('string'), { explicitArray: true });
    const plates: any[] = parsed?.config?.plate ?? [];
    const selected = plates.find(plate => (plate?.metadata ?? [])
        .some((item: any) => item?.$?.key === 'index' && Number(item?.$?.value) === plateNumber));
    if (!selected) {
        throw new Error(`Plate ${plateNumber} was not sliced in this 3MF, so it has no skip-object ids.`);
    }
    const labelObjectEnabled = (selected.metadata ?? [])
        .some((item: any) => item?.$?.key === 'label_object_enabled' && item?.$?.value === 'true');
    const instances = (selected.object ?? []).flatMap((object: any) => {
        const id = Number(object?.$?.identify_id);
        if (!Number.isSafeInteger(id) || id <= 0) return [];
        return [{ id, name: typeof object.$.name === 'string' ? object.$.name : `object_${id}`, skipped: object.$.skipped === 'true' }];
    });

    // First-layer area and box, attached by name only where one instance and one box carry it.
    const boxes = new Map<string, any[]>();
    const plateFile = zip.file(`Metadata/plate_${plateNumber}.json`);
    if (plateFile) {
        try {
            const plateJson = JSON.parse(await plateFile.async('string'));
            for (const box of Array.isArray(plateJson?.bbox_objects) ? plateJson.bbox_objects : []) {
                if (typeof box?.name !== 'string' || box.name === 'wipe_tower') continue;
                boxes.set(box.name, [...(boxes.get(box.name) ?? []), box]);
            }
        } catch {
            // The ids above still stand without the boxes.
        }
    }
    const nameCount = new Map<string, number>();
    for (const instance of instances) nameCount.set(instance.name, (nameCount.get(instance.name) ?? 0) + 1);

    return {
        plateIndex,
        labelObjectEnabled,
        objects: instances.map((instance: { id: number; name: string; skipped: boolean }) => {
            const box = nameCount.get(instance.name) === 1 && boxes.get(instance.name)?.length === 1 ? boxes.get(instance.name)![0] : undefined;
            return {
                ...instance,
                area: box && Number.isFinite(Number(box.area)) ? Number(box.area) : null,
                bbox: box?.bbox ?? null,
            };
        }),
    };
}
