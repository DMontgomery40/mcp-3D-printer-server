/**
 * Every error code the Bambu Studio CLI can exit with, from libslic3r/Utils.hpp:21-75 of Bambu Studio
 * 02.08.02.61 (OrcaSlicer's CLI shares them). The names and numbers are Studio's; the sentences are ours.
 * The process exits with the code's low byte (-50 exits as 206). The CLI's own result.json, when present and
 * fresh, is still the better reason; this table is for when it is missing or stale.
 *
 * tests/slicer/cli-exit-codes.test.mjs checks the names and numbers against Utils.hpp's list.
 */
export const BAMBU_CLI_EXIT_CODES: Record<number, { name: string; sentence: string }> = {
  [-1]: { name: "CLI_ENVIRONMENT_ERROR", sentence: "the slicer could not set up its working environment" },
  [-2]: { name: "CLI_INVALID_PARAMS", sentence: "the slicer was given options it does not accept" },
  [-3]: { name: "CLI_FILE_NOTFOUND", sentence: "an input file was not found" },
  [-4]: { name: "CLI_FILELIST_INVALID_ORDER", sentence: "the input files were in the wrong order (a 3MF has to come first)" },
  [-5]: { name: "CLI_CONFIG_FILE_ERROR", sentence: "a settings file could not be read" },
  [-6]: { name: "CLI_DATA_FILE_ERROR", sentence: "the model file could not be read" },
  [-7]: { name: "CLI_INVALID_PRINTER_TECH", sentence: "the printer settings are not for a filament (FDM) printer" },
  [-8]: { name: "CLI_UNSUPPORTED_OPERATION", sentence: "the slicer does not support that operation" },
  [-9]: { name: "CLI_COPY_OBJECTS_ERROR", sentence: "making copies of the objects failed" },
  [-10]: { name: "CLI_SCALE_TO_FIT_ERROR", sentence: "scaling the model to fit the bed failed" },
  [-11]: { name: "CLI_EXPORT_STL_ERROR", sentence: "writing the STL file failed" },
  [-12]: { name: "CLI_EXPORT_OBJ_ERROR", sentence: "writing the OBJ file failed" },
  [-13]: { name: "CLI_EXPORT_3MF_ERROR", sentence: "writing the 3MF file failed" },
  [-14]: { name: "CLI_OUT_OF_MEMORY", sentence: "the slicer ran out of memory" },
  [-15]: { name: "CLI_3MF_NOT_SUPPORT_MACHINE_CHANGE", sentence: "this 3MF can't be moved to the chosen printer" },
  [-16]: { name: "CLI_3MF_NEW_MACHINE_NOT_SUPPORTED", sentence: "the chosen printer can't be used with this 3MF" },
  [-17]: { name: "CLI_PROCESS_NOT_COMPATIBLE", sentence: "the process settings don't fit the chosen printer" },
  [-18]: { name: "CLI_INVALID_VALUES_IN_3MF", sentence: "the 3MF holds settings values the slicer rejects" },
  [-19]: { name: "CLI_POSTPROCESS_NOT_SUPPORTED", sentence: "the settings use post-processing scripts, which the slicer CLI doesn't run" },
  [-20]: { name: "CLI_PRINTABLE_SIZE_REDUCED", sentence: "the chosen printer's bed is smaller than the one the settings were made for" },
  [-21]: { name: "CLI_OBJECT_ARRANGE_FAILED", sentence: "arranging the objects on the plate failed" },
  [-22]: { name: "CLI_OBJECT_ORIENT_FAILED", sentence: "turning the objects to print well failed" },
  [-23]: { name: "CLI_MODIFIED_PARAMS_TO_PRINTER", sentence: "the printer settings change its bed area, height or excluded area, which isn't allowed" },
  [-24]: { name: "CLI_FILE_VERSION_NOT_SUPPORTED", sentence: "the 3MF was saved by a slicer version this one can't read (often a beta)" },
  [-25]: { name: "CLI_3MF_FEATURE_NOT_SUPPORTED", sentence: "the 3MF uses an experimental feature this slicer doesn't support yet" },
  [-50]: { name: "CLI_NO_SUITABLE_OBJECTS", sentence: "a plate is empty or has no object fully inside it; arrange the model or place it on the plate" },
  [-51]: { name: "CLI_VALIDATE_ERROR", sentence: "the slicing settings failed the slicer's own checks" },
  [-52]: { name: "CLI_OBJECTS_PARTLY_INSIDE", sentence: "objects extend over the bed boundary" },
  [-53]: { name: "CLI_EXPORT_CACHE_DIRECTORY_CREATE_FAILED", sentence: "the slicer couldn't create its cache folder" },
  [-54]: { name: "CLI_EXPORT_CACHE_WRITE_FAILED", sentence: "the slicer couldn't write its cache" },
  [-55]: { name: "CLI_IMPORT_CACHE_NOT_FOUND", sentence: "the slicer's cache wasn't found" },
  [-56]: { name: "CLI_IMPORT_CACHE_DATA_CAN_NOT_USE", sentence: "the slicer's cache couldn't be read" },
  [-57]: { name: "CLI_IMPORT_CACHE_LOAD_FAILED", sentence: "loading the slicer's cache failed" },
  [-58]: { name: "CLI_SLICING_TIME_EXCEEDS_LIMIT", sentence: "slicing a plate took longer than the time limit; simplify the model or use a taller layer height" },
  [-59]: { name: "CLI_TRIANGLE_COUNT_EXCEEDS_LIMIT", sentence: "a plate has more triangles than the limit; simplify the model" },
  [-60]: { name: "CLI_NO_SUITABLE_OBJECTS_AFTER_SKIP", sentence: "no printable objects remain after skipping" },
  [-61]: { name: "CLI_FILAMENT_NOT_MATCH_BED_TYPE", sentence: "a filament can't be printed on the chosen plate type" },
  [-62]: { name: "CLI_FILAMENTS_DIFFERENT_TEMP", sentence: "the filaments' temperatures differ too much" },
  [-63]: { name: "CLI_OBJECT_COLLISION_IN_SEQ_PRINT", sentence: "objects collide in print-by-object mode" },
  [-64]: { name: "CLI_OBJECT_COLLISION_IN_LAYER_PRINT", sentence: "objects collide" },
  [-65]: { name: "CLI_SPIRAL_MODE_INVALID_PARAMS", sentence: "some settings can't be used in spiral vase mode" },
  [-66]: { name: "CLI_FILAMENT_CAN_NOT_MAP", sentence: "some filaments can't be assigned to the printer's nozzles" },
  [-67]: { name: "CLI_ONLY_ONE_TPU_SUPPORTED", sentence: "only one TPU filament can be used in a print" },
  [-68]: { name: "CLI_FILAMENTS_NOT_SUPPORTED_BY_EXTRUDER", sentence: "a filament can't be printed by the nozzle it is assigned to" },
  [-100]: { name: "CLI_SLICING_ERROR", sentence: "slicing the model failed" },
  [-101]: { name: "CLI_GCODE_PATH_CONFLICTS", sentence: "the print paths of two objects overlap; move them apart, or move the wipe tower away from the models" },
  [-102]: { name: "CLI_GCODE_PATH_IN_UNPRINTABLE_AREA", sentence: "the print reaches an area one of the printer's nozzles can't print" },
  [-103]: { name: "CLI_FILAMENT_UNPRINTABLE_ON_FIRST_LAYER", sentence: "a filament can't be printed on the first layer of this plate type" },
  [-104]: { name: "CLI_GCODE_PATH_OUTSIDE", sentence: "the print goes outside the printable area, usually through a support, brim, skirt or the wipe tower" },
  [-105]: { name: "CLI_GCODE_IN_WRAPPING_DETECT_AREA", sentence: "the print goes into the bed area the printer keeps clear for its clumping (wrapping) check" },
};

/** The table's entry for a process exit status (the code's low byte) or a full negative code. */
export function bambuCliExitCode(exitCode: unknown): { code: number; name: string; sentence: string } | undefined {
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode === 0) return undefined;
  const code = Object.keys(BAMBU_CLI_EXIT_CODES).map(Number)
    .find(value => value === exitCode || (value & 0xff) === exitCode);
  return code === undefined ? undefined : { code, ...BAMBU_CLI_EXIT_CODES[code] };
}
