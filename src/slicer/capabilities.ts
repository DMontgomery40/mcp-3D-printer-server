/**
 * What a slice from this server can do with the slicer it runs (counterpart_printer_info
 * capabilities.slicing). Clients such as Counterpart offer supports, copies and auto-orient only
 * when this says so, instead of knowing which slicer accepts what.
 *
 * The Bambu-compatible CLI route (Bambu Studio, FULU OrcaSlicer-bambulab, or OrcaSlicer given a
 * Bambu model) takes all three. Generic OrcaSlicer takes the support keys over its process profile.
 * PrusaSlicer, Slic3r and Cura take none of them through this server.
 */
export interface SliceCapabilities {
  supports: boolean;
  copies: boolean;
  orient: boolean;
}

export function isBambuProjectSlicer(slicerType: string): boolean {
  return slicerType === "orcaslicer-bambulab" || slicerType === "bambustudio";
}

/** True when slice_stl uses the Bambu-compatible CLI route for this slicer and target. */
export function usesBambuCli(slicerType: string, bambuModel: boolean): boolean {
  return isBambuProjectSlicer(slicerType) || (slicerType === "orcaslicer" && bambuModel);
}

export function sliceCapabilities(slicerType: string, bambuModel: boolean): SliceCapabilities {
  const bambuCli = usesBambuCli(slicerType, bambuModel);
  return { supports: bambuCli || slicerType === "orcaslicer", copies: bambuCli, orient: bambuCli };
}
