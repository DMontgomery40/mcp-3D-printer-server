import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BAMBU_CLI_EXIT_CODES, bambuCliExitCode } from '../../dist/slicer/cli-exit-codes.js';

// The CLI error codes Bambu Studio 02.08.02.61 defines (libslic3r/Utils.hpp:21-75), as [number, name].
const STUDIO_02_08_02_61 = new Map([
  [-1, 'CLI_ENVIRONMENT_ERROR'],
  [-2, 'CLI_INVALID_PARAMS'],
  [-3, 'CLI_FILE_NOTFOUND'],
  [-4, 'CLI_FILELIST_INVALID_ORDER'],
  [-5, 'CLI_CONFIG_FILE_ERROR'],
  [-6, 'CLI_DATA_FILE_ERROR'],
  [-7, 'CLI_INVALID_PRINTER_TECH'],
  [-8, 'CLI_UNSUPPORTED_OPERATION'],
  [-9, 'CLI_COPY_OBJECTS_ERROR'],
  [-10, 'CLI_SCALE_TO_FIT_ERROR'],
  [-11, 'CLI_EXPORT_STL_ERROR'],
  [-12, 'CLI_EXPORT_OBJ_ERROR'],
  [-13, 'CLI_EXPORT_3MF_ERROR'],
  [-14, 'CLI_OUT_OF_MEMORY'],
  [-15, 'CLI_3MF_NOT_SUPPORT_MACHINE_CHANGE'],
  [-16, 'CLI_3MF_NEW_MACHINE_NOT_SUPPORTED'],
  [-17, 'CLI_PROCESS_NOT_COMPATIBLE'],
  [-18, 'CLI_INVALID_VALUES_IN_3MF'],
  [-19, 'CLI_POSTPROCESS_NOT_SUPPORTED'],
  [-20, 'CLI_PRINTABLE_SIZE_REDUCED'],
  [-21, 'CLI_OBJECT_ARRANGE_FAILED'],
  [-22, 'CLI_OBJECT_ORIENT_FAILED'],
  [-23, 'CLI_MODIFIED_PARAMS_TO_PRINTER'],
  [-24, 'CLI_FILE_VERSION_NOT_SUPPORTED'],
  [-25, 'CLI_3MF_FEATURE_NOT_SUPPORTED'],
  [-50, 'CLI_NO_SUITABLE_OBJECTS'],
  [-51, 'CLI_VALIDATE_ERROR'],
  [-52, 'CLI_OBJECTS_PARTLY_INSIDE'],
  [-53, 'CLI_EXPORT_CACHE_DIRECTORY_CREATE_FAILED'],
  [-54, 'CLI_EXPORT_CACHE_WRITE_FAILED'],
  [-55, 'CLI_IMPORT_CACHE_NOT_FOUND'],
  [-56, 'CLI_IMPORT_CACHE_DATA_CAN_NOT_USE'],
  [-57, 'CLI_IMPORT_CACHE_LOAD_FAILED'],
  [-58, 'CLI_SLICING_TIME_EXCEEDS_LIMIT'],
  [-59, 'CLI_TRIANGLE_COUNT_EXCEEDS_LIMIT'],
  [-60, 'CLI_NO_SUITABLE_OBJECTS_AFTER_SKIP'],
  [-61, 'CLI_FILAMENT_NOT_MATCH_BED_TYPE'],
  [-62, 'CLI_FILAMENTS_DIFFERENT_TEMP'],
  [-63, 'CLI_OBJECT_COLLISION_IN_SEQ_PRINT'],
  [-64, 'CLI_OBJECT_COLLISION_IN_LAYER_PRINT'],
  [-65, 'CLI_SPIRAL_MODE_INVALID_PARAMS'],
  [-66, 'CLI_FILAMENT_CAN_NOT_MAP'],
  [-67, 'CLI_ONLY_ONE_TPU_SUPPORTED'],
  [-68, 'CLI_FILAMENTS_NOT_SUPPORTED_BY_EXTRUDER'],
  [-100, 'CLI_SLICING_ERROR'],
  [-101, 'CLI_GCODE_PATH_CONFLICTS'],
  [-102, 'CLI_GCODE_PATH_IN_UNPRINTABLE_AREA'],
  [-103, 'CLI_FILAMENT_UNPRINTABLE_ON_FIRST_LAYER'],
  [-104, 'CLI_GCODE_PATH_OUTSIDE'],
  [-105, 'CLI_GCODE_IN_WRAPPING_DETECT_AREA'],
]);

function parseDefines(text) {
  return new Map([...text.matchAll(/^#define\s+(CLI_\w+)\s+(-\d+)/gm)]
    .filter(([, name]) => name !== 'CLI_SUCCESS').map(([, name, code]) => [Number(code), name]));
}

test('the CLI exit-code table holds every code Bambu Studio 02.08.02.61 defines, by name and number', () => {
  const studio = STUDIO_02_08_02_61;
  assert.equal(studio.size, 50);
  const ours = new Map(Object.entries(BAMBU_CLI_EXIT_CODES).map(([code, entry]) => [Number(code), entry.name]));
  assert.deepEqual([...ours].sort((a, b) => a[0] - b[0]), [...studio].sort((a, b) => a[0] - b[0]));
  for (const entry of Object.values(BAMBU_CLI_EXIT_CODES)) assert.match(entry.sentence, /\w/);
});

test('a Studio checkout next to this one, when present, still matches the table', { skip: !fs.existsSync(path.join(os.homedir(), 'refs/BambuStudio/src/libslic3r/Utils.hpp')) }, () => {
  const studio = parseDefines(fs.readFileSync(path.join(os.homedir(), 'refs/BambuStudio/src/libslic3r/Utils.hpp'), 'utf8'));
  for (const [code, name] of studio) assert.equal(BAMBU_CLI_EXIT_CODES[code]?.name, name, `${name} ${code}`);
});

test('a process exit status resolves through the code\'s low byte', () => {
  // The CLI exits with the low byte: -66 (CLI_FILAMENT_CAN_NOT_MAP) is exit status 190.
  assert.equal(bambuCliExitCode(190)?.name, 'CLI_FILAMENT_CAN_NOT_MAP');
  assert.equal(bambuCliExitCode(206)?.code, -50);
  assert.equal(bambuCliExitCode(151)?.name, 'CLI_GCODE_IN_WRAPPING_DETECT_AREA');
  assert.equal(bambuCliExitCode(-68)?.name, 'CLI_FILAMENTS_NOT_SUPPORTED_BY_EXTRUDER');
  assert.equal(bambuCliExitCode(0), undefined);
  assert.equal(bambuCliExitCode(1), undefined);
  assert.equal(bambuCliExitCode('206'), undefined);
});
