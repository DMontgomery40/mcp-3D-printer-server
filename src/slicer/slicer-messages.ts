/**
 * A slicer's refusal in plain words. Bambu Studio, OrcaSlicer, PrusaSlicer and CuraEngine word their errors for
 * their own windows ("One of the plate is empty or has no object fully inside it..."); a client shows the person
 * the sentence here and keeps the slicer's own words for its logs (`slicer_report.slicer_message`).
 *
 * The phrases are the slicers' own strings: Bambu Studio 02.09 and OrcaSlicer 2.3 (their CLI and validation
 * messages), PrusaSlicer 2.9.2 (src/libslic3r/Print.cpp, src/CLI/ProcessActions.cpp) and CuraEngine
 * (src/FffPolygonGenerator.cpp). Matching is on a lowercase fragment, so a version that adds a prefix or a
 * plate number still matches.
 */
const PLAIN: { phrases: string[]; sentence: string }[] = [
  {
    phrases: [
      "one of the plate is empty or has no object fully inside it",
      "a plate is empty or has no object fully inside it",
      "cannot send the print job for empty plate",
      "no object is fully inside the print volume",
      "found no objects in print volume to slice",
      "found no objects in print volume after skip",
      "all objects are outside of the print volume",
      "arrangement ignored the following objects which can't fit into a single bed",
    ],
    sentence: "Nothing on this plate can be printed: no part sits fully on the bed. A part is off the plate or across its edge, or the model is bigger than the bed.",
  },
  {
    phrases: [
      "laid over the boundary of plate or exceeds the height limit",
      "layed over the boundary of plate",
      "laid over the plate boundaries",
      "partly inside, can not be sliced",
      "located over the boundary of the heated bed",
    ],
    sentence: "A part sits across the edge of the plate, or is taller than the printer can print, so it can't be sliced as it is placed.",
  },
  {
    phrases: ["exceeds the maximum build volume height", "exceeds the printable height"],
    sentence: "The model is taller than the printer can print.",
  },
  {
    phrases: ["object too large", "scale to fit error", "printable area/volume reduced"],
    sentence: "The model is larger than the printer's bed.",
  },
  {
    phrases: ["found g-code outside of the printable area", "found g-code in unprintable area", "g-code path exceeds the printable range"],
    sentence: "The print would go outside the area the printer can reach, usually a brim, skirt, support or the wipe tower near an edge. Move the model further onto the plate.",
  },
  {
    phrases: ["g-code path conflicts found", "found gcode path conflicts between object"],
    sentence: "Two parts are so close that their print paths overlap. Move them apart.",
  },
  {
    phrases: ["the supplied settings will cause an empty print", "there are no non-empty layers"],
    sentence: "These settings would print nothing: no layer of the model has anything to print.",
  },
];

/** The plain sentence for a slicer's error, or undefined when the words aren't one this knows. */
export function plainSlicerError(words: string): string | undefined {
  const text = words.toLowerCase();
  return PLAIN.find(entry => entry.phrases.some(phrase => text.includes(phrase)))?.sentence;
}

/** What a person is told when the slicer refused with words this doesn't know. */
export const UNKNOWN_SLICER_ERROR = "The slicer couldn't slice this model. Its own message is kept for the log.";
