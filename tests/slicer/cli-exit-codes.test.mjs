import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BAMBU_CLI_EXIT_CODES, bambuCliExitCode } from '../../dist/slicer/cli-exit-codes.js';

// Bambu Studio 02.08.02.61 libslic3r/Utils.hpp:21-75, every error code after CLI_SUCCESS, verbatim.
const UTILS_HPP_02_08_02_61 = `
#define CLI_ENVIRONMENT_ERROR       -1
#define CLI_INVALID_PARAMS          -2
#define CLI_FILE_NOTFOUND           -3
#define CLI_FILELIST_INVALID_ORDER  -4
#define CLI_CONFIG_FILE_ERROR       -5
#define CLI_DATA_FILE_ERROR         -6
#define CLI_INVALID_PRINTER_TECH    -7
#define CLI_UNSUPPORTED_OPERATION   -8
#define CLI_COPY_OBJECTS_ERROR      -9
#define CLI_SCALE_TO_FIT_ERROR      -10
#define CLI_EXPORT_STL_ERROR        -11
#define CLI_EXPORT_OBJ_ERROR        -12
#define CLI_EXPORT_3MF_ERROR        -13
#define CLI_OUT_OF_MEMORY           -14
#define CLI_3MF_NOT_SUPPORT_MACHINE_CHANGE      -15
#define CLI_3MF_NEW_MACHINE_NOT_SUPPORTED       -16
#define CLI_PROCESS_NOT_COMPATIBLE     -17
#define CLI_INVALID_VALUES_IN_3MF      -18
#define CLI_POSTPROCESS_NOT_SUPPORTED  -19
#define CLI_PRINTABLE_SIZE_REDUCED     -20
#define CLI_OBJECT_ARRANGE_FAILED      -21
#define CLI_OBJECT_ORIENT_FAILED       -22
#define CLI_MODIFIED_PARAMS_TO_PRINTER -23
#define CLI_FILE_VERSION_NOT_SUPPORTED -24
#define CLI_3MF_FEATURE_NOT_SUPPORTED  -25
#define CLI_NO_SUITABLE_OBJECTS     -50
#define CLI_VALIDATE_ERROR          -51
#define CLI_OBJECTS_PARTLY_INSIDE   -52
#define CLI_EXPORT_CACHE_DIRECTORY_CREATE_FAILED   -53
#define CLI_EXPORT_CACHE_WRITE_FAILED   -54
#define CLI_IMPORT_CACHE_NOT_FOUND      -55
#define CLI_IMPORT_CACHE_DATA_CAN_NOT_USE -56
#define CLI_IMPORT_CACHE_LOAD_FAILED      -57
#define CLI_SLICING_TIME_EXCEEDS_LIMIT      -58
#define CLI_TRIANGLE_COUNT_EXCEEDS_LIMIT    -59
#define CLI_NO_SUITABLE_OBJECTS_AFTER_SKIP  -60
#define CLI_FILAMENT_NOT_MATCH_BED_TYPE     -61
#define CLI_FILAMENTS_DIFFERENT_TEMP        -62
#define CLI_OBJECT_COLLISION_IN_SEQ_PRINT   -63
#define CLI_OBJECT_COLLISION_IN_LAYER_PRINT -64
#define CLI_SPIRAL_MODE_INVALID_PARAMS      -65
#define CLI_FILAMENT_CAN_NOT_MAP      -66
#define CLI_ONLY_ONE_TPU_SUPPORTED      -67
#define CLI_FILAMENTS_NOT_SUPPORTED_BY_EXTRUDER  -68
#define CLI_SLICING_ERROR                  -100
#define CLI_GCODE_PATH_CONFLICTS           -101
#define CLI_GCODE_PATH_IN_UNPRINTABLE_AREA -102
#define CLI_FILAMENT_UNPRINTABLE_ON_FIRST_LAYER -103
#define CLI_GCODE_PATH_OUTSIDE             -104
#define CLI_GCODE_IN_WRAPPING_DETECT_AREA  -105
`;

function parseDefines(text) {
  return new Map([...text.matchAll(/^#define\s+(CLI_\w+)\s+(-\d+)/gm)]
    .filter(([, name]) => name !== 'CLI_SUCCESS').map(([, name, code]) => [Number(code), name]));
}

test('the CLI exit-code table holds every code Bambu Studio 02.08.02.61 defines, by name and number', () => {
  const studio = parseDefines(UTILS_HPP_02_08_02_61);
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
