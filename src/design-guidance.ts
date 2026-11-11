import { CAD_DESIGN_PROMPT } from "./cad/contracts.js";
/**
 * Manufacturing guidance for agents that design printable models: David Montgomery's FDM design
 * prompt pack (3 November 2026), with later fit, flexure and printed-fastener guidance in the
 * same voice. Served as MCP prompts and resources; the other printer MCP (bambu-printer-mcp /
 * mcp-3D-printer-server) serves the same text. Clients choose when to attach each piece.
 */

export interface DesignPrompt { name: string; title: string; description: string; text: string }

export const FDM_CORE = `Design the finished object the user wants, with the manufacturing plan as part of the design. Preserve its function, fit, and visual identity. Use your design ability freely to make that outcome practical through geometry, orientation, materials, color placement, supports, and assembly.

Use the actual printer and material context: nozzle arrangement and filament routing, build volume, nozzle and line widths, layer profile, cooling, available filaments, and relevant successful prints or calibration. Missing information is unknown, not a capability the printer automatically has. Use reasonable, labeled assumptions for reversible choices; ask only when an unknown materially changes the result.

Before committing to detailed geometry, choose a plausible way to manufacture and assemble it. For a consequential tradeoff, compare the strongest one-piece approach with a meaningfully different orientation or split. Simple parts do not need a design tournament. Judge total effort to obtain a good finished object: printing, consumed filament, likely rework, support cleanup, assembly, and extra hardware. Respect the user's priorities instead of applying fixed numerical weights.

Keep assembled orientation and print orientation distinct. Preserve critical dimensions and mating surfaces. Account for measurement uncertainty and fit clearance separately; a scan or printed measuring tool does not establish its own accuracy. Use the smallest useful fit sample when uncertainty could otherwise waste a substantial print. When the request names a product, a vehicle, or a standard part, look up its published dimensions and use them, labelled as published. A size the person confirmed without changing a prefilled number is not a measurement. If a case, cover, or attachment is mentioned, the bare product's size is not the size to design to. Ask the person only for what no source gives, and where possible shape the design so an unmeasured dimension does not decide whether it works.

Choose each fit by what that interface has to do: drop in and lift out, slide, locate without rattle, grip so it does not slip or turn, snap over, or press in to stay. There is no single fit number. Keep three things apart for each interface: the object's size and how sure it is, the correction this printer and orientation need (its own observed corrections first, when the context supplies them), and the fit the function calls for. When the size's uncertainty is wider than the function tolerates, do not answer with a better number: choose a mechanism that absorbs the difference (crush ribs, a split closed by a screw, a flexure, a snap), or ask for the one measurement that settles it. The same object changes with time and use: full and nearly empty, new and worn, soft and stiff. A fit that relies on the object giving way must still work in its stiffest, largest state, and a pocket is sized to the widest section the object passes through on the way in, with support where the object actually bears, not to its bounding box.

Evaluate printability locally. Distinguish a progressively supported overhang, a bridge anchored at both ends, and a disconnected island. State overhang angles from vertical: 0 degrees is a vertical wall; 90 degrees is a horizontal underside. Convert conventions before setting slicer angles. Use relevant measured capability ahead of generic rules. A 45-degree threshold is not a universal support requirement, and a steep surface is not automatically unprintable. Judge bridge length along the actual unsupported extrusion path, with its anchors, cooling, material, and required underside quality. A feature that survives printing may still miss a cosmetic or dimensional requirement.

Resolve a difficult region with the least disruptive effective change: a better orientation, local geometry, suitable process settings, accessible support, a deliberate breakaway feature, or a split. Supports are an ordinary manufacturing option. Preserve attractive curves and useful complexity when modest support or cleanup achieves them. Check support removal and tool access, especially inside cavities. Avoid changing the whole object to solve a local problem.

Choose layer orientation, material, walls, and joints for the actual loads and environment. Check the load path, flexing features, fastener access, and installation sequence. A reduction in supports or color changes must not silently weaken the part or defeat its fit.

When a part must flex, grip, snap, clip, spring, or hold something, consider a compliant mechanism first: one piece that bends on purpose often beats rigid jaws plus a clamp bolt, with fewer parts, no fastener to buy or lose, and a hold that follows the object. Spread the bending over a long band, leaf, or arch rather than a short stub; keep the rest of the body stiff so the stroke goes where you intend; give a hand enough leverage; design the preload in; use an over-centre or cam where a hold must lock; and give every flexing direction a hard stop so a hard pull meets solid material. Keep the bending in the layer plane, where the filament runs along the strain; bending that pulls layers apart is far weaker and fails with little warning. Choose the strain by duty (bent once to assemble, bent every day, and held bent for months are different designs) and by material and direction, using the printer's own observed values when the context supplies them. Modern PLA and PETG grades are not brittle in this role: proven printed springs work daily at strains that older moulded-plastic tables would forbid. What usually ends a flexure is not a clean snap at a magic percentage but whitening and set at a sharp root, layers parting where the bend crosses them, or a held bend creeping loose, faster when warm. In sustained heat such as a parked car, a part held bent relaxes and a sun-heated dashboard can exceed what PLA or PETG carry under load: prefer a rest state that sits unstrained, and say so when the material cannot honestly do the job. A part a hand works has to be easy to work, and that is checked like its hold: say where the fingers go, how hard they push to open it, how far it opens, and how the object goes in and comes out with one hand. A grip that meets its force and is a fight to use has failed the brief.

On a shared-nozzle multicolor setup, reason about filament transitions across layers, including support-interface material. Total color count alone is a poor cost estimate. Consider color placement, shallow inlays, separately printed accents, and part orientation while preserving the requested appearance. Separate bodies on one layer-printed plate can still cause repeated swaps. Use the slicer's actual schedule and estimates when available; do not invent a fixed cost per color change.

Use assembly when its benefit is worth the user's additional work. Design alignment, clearance, engagement, and assembly access deliberately. Glue is a valid planned joining method for suitable materials and loads; make joints self-locating and give them useful bonding area. Use mechanical retention when loads, repeated flexing, or serviceability call for it. State needed glue, hardware, tools, and assembly effort plainly. Avoid adding parts when a modest support or a simple one-piece print is the better result. A printed screw, nut, or threaded hole is an ordinary choice at hand sizes (M8 and up as the usual starting point, about M6 as the floor) with a coarse profile shaped to print without supports; below that floor, under sustained preload that must not relax, in heat, or under shock, a metal screw or insert is the honest choice. Keep threads out of the main load path where a shoulder, tenon, key, or serrated face can carry shear and torque, and let the thread only hold the joint closed.

Verify the chosen geometry in its actual print orientation and inspect the slice when tools permit. Check critical fits, missing or floating features, toolpaths, supports, color assignments, total time, and material consumption. Treat a slicer prediction as a prediction, not a physical test. Fix consequential problems and re-slice relevant changes. Stop when the design meets the brief and no remaining improvement justifies its cost. State "prints without supports", "holds", or "fits" only when the engine's own checks or the slice show it, and give the number that shows it; otherwise call it an untested prediction.

Keep the user-facing result short: the recommended design, why its manufacturing approach makes sense, how it prints and assembles, and any consequential unresolved assumption. Distinguish measured dimensions, slicer estimates, and untested predictions. Say where each critical size came from (measured, published, or assumed) and what each interface is meant to do and how it fits. Keep detailed analysis in the working process.`;

export const FDM_MULTICOLOR = `Apply this guidance when multiple colors or support materials share a print.

Preserve the requested visual pattern. Evaluate its colors in build coordinates and across layers before committing to color geometry. On a shared nozzle, a small accent spanning many layers can create more transitions than a large region confined to a few layers. Count the slicer's actual transitions when available, including swaps back to a prior filament and support-interface swaps; color count and colored volume are only screening clues. On printers with multiple nozzles, evaluate each shared melt path; AMS slots are not independent nozzles.

For a costly pattern, consider the most promising alternatives: a different build orientation, color regions confined to fewer layers, shallow face inlays, or separately printed single-color pieces with intentional assembly. A vertical stripe in use may become a low-change feature in a different print orientation. Judge each option against load direction, surface quality, support burden, and the user's exact visual requirements. Finer layers can help an overhang while adding color-change layers; evaluate local adaptive layers and re-slice the combined plan.

Separating color bodies does not by itself eliminate swaps. Check plate scheduling. Single-color plates can remove repeated color changes; by-layer printing of different-color objects together usually cannot. Use sequential object printing only when supported and its clearance constraints are satisfied. Batch copies only when the user wants them.

Use the actual directional flushing matrix and filament compatibility. Purging clears previous material; priming restores consistent extrusion. Track those separately when the slicer does. Flushing into compatible infill or supports may reduce discarded material, but it does not remove switching time, has finite capacity, and can affect appearance or strength. Do not add unnecessary infill or objects merely to hide waste.

Compare the same requested quantity and finish. Report total filament and time across all plates, plus purge, tower, and support quantities only where available without double counting. Unknown metrics remain unknown. Recommend the original multicolor approach when the user values its seamless result enough to justify its cost.`;

export const FDM_ASSEMBLY = `Apply this guidance when a split, insert, or joint may materially improve the result.

Compare assembly against the best practical one-piece approach, including reasonable supports. A split earns its place by improving important surfaces, layer strength, fit, color efficiency, support access, repairability, or bed fit enough to justify handling and joining the pieces. Prefer a one-piece solution when its support cleanup is easier than assembly and the alternatives meet the other important requirements comparably well. Respect an explicit one-piece or no-glue requirement.

Put boundaries where they are structurally sensible and visually deliberate. Use shoulders, keys, overlapping faces, tabs, or pins to locate parts and resist sliding or rotation as appropriate. Include fit clearance, lead-ins, adhesive space where needed, and a feasible insertion path. Check the assembled geometry and the order of operations, not only the separated pieces. Avoid joints whose screws, clamps, or mating faces become inaccessible during assembly.

For suitable lightly loaded rigid details, a locating pocket plus a compatible adhesive can be the simplest reliable solution. For a loaded clamp, a joint under peel or repeated bending, or a serviceable assembly, consider fasteners or mechanically captured geometry. Do not assume a tiny glued butt joint can carry the same load as an intact printed section. Select adhesive from evidence for the actual materials and conditions; superglue is an option, not a universal material property.

State the practical consequence directly: which parts print in which orientations and colors, how they locate, how they are retained, which supplies are needed, and the estimated hands-on work. Keep hands-on time separate from adhesive cure time. Check a small joint sample only when its uncertain fit or strength would change the design decision.

Printed threads need a profile made for printing, not a copy of a metal V-thread. A coarse, truncated thread whose flanks sit within the printer's proven overhang (one widely printed all-plastic kit uses about a 96-degree included angle, 42 degrees from vertical, at pitches of roughly 2-3 mm for M8-M12 sizes, cleared by roughly two tenths of a millimetre per side at the pitch line) prints upright without supports and keeps its teeth in solid wall loops. Keep the pitch exactly the same on screw and hole; make clearance by shifting the profile radially, never by scaling the screw, which changes the pitch and wedges after a few turns. Give a hand screw several full turns of engagement and a knob that limits how hard it can be torqued. A long, slender screw that must pull or bend is better printed flat or split so filament runs along its length than stood upright across its layers. Where preload must survive months, heat, or shock, or the size is below about M6-M8, use a metal screw or heat-set insert and say so. When the context supplies this printer's own thread fit observation, use it ahead of any generic allowance.`;

export const FDM_AFTER_SLICE = `Review this slice against the user's brief and the selected manufacturing plan. Use the returned slice, geometry, profile, and calibration evidence; do not assume missing metrics are zero.

Check that the actual toolpaths preserve critical features, fit, connected material, intended colors, and load-bearing sections. Inspect consequential first layers, bridges, islands, supported undersides, and removal access. Compare expected total print time, total material across all plates, and manual work with the best credible alternative. Keep purge, prime-tower, support, and model quantities distinct only when the data provides a non-overlapping breakdown.

If the plan is unexpectedly costly or fragile, identify the dominant cause and make the smallest change that preserves the brief. Re-slice after a relevant geometry, orientation, material, or process change. Do not optimize a minor imperfection at the expense of function or appearance, and do not invent a redesign simply to produce criticism. Check every support, fit, and hold claim in the summary against a number from the slice or the engine's checks (support area and worst overhang, engagement and gap, estimated bite at the forced opening). A claim without its number comes out or is labelled a prediction.

Return a concise decision: keep, revise, or validate one specific uncertainty. Include the decisive evidence and the exact next action. A clean slice supports a printability prediction; it does not verify physical fit, strength, or bridge quality.`;

export const FDM_FLEXURES = `Apply this guidance when a part must flex, grip, snap, clip, spring, or hold something by bending. The strain bands below are planning bands drawn from manufacturer printed-specimen cards, measurements of published mechanisms that survive daily use, and single-printer coupon readings. They are not guarantees and not rejection thresholds. When the context supplies this printer's own observed values for the same filament, profile and duty, design to those and keep the generic band as the starting point for everything else.

A compliant design earns its place when one bending piece replaces rigid jaws, a hinge and a clamp bolt: fewer parts, nothing to buy or lose, one print, and a hold that follows the object as it varies. Prefer it for holders, clips, snaps, lids and latches a hand operates. Do not force it where the job is precise location under a heavy sustained load, a preload that must not relax for months in heat, or travel and force together beyond what a spring can give. There, let solid geometry carry the load (a pin, saddle, rail, shoulder or latch) and let a spring only preload, return, or take up slack.

Choose the architecture before the dimensions. A long leaf, band or arch spreads strain over its length; a short stub concentrates it at the root and either cracks or barely moves. A pair of leaves guided at both ends moves its jaw straight, without tilting. Folding the spring back on itself (a serpentine or S) buys travel in a small space at the same strain. A thick curved arch gives a strong bite over a short opening. An over-centre toggle or cam locks past its peak so the locked strain is lower than the click that got there, and both rest states can sit nearly unstrained. A shallow pre-curved beam latched flat seals along its length while held at a fraction of a percent. A cam lever earns a hard bite by putting its small lift into a short, stiff spring, not by bending long jaws. In every case keep the surrounding body much stiffer than the spring, size the leverage to the hand that works it, design the preload in rather than hoping assembly provides it, and put a solid hard stop just past the working stroke so an oversize object or a hard yank meets compression instead of ever-rising strain.

Judge bite at the opening the object actually forces, where the force is taken. The same clip is several times stiffer when a flat rigid object holds its jaws from turning than when a round finger lets them turn; one measured clip changed about fivefold between those contacts. Grip that must not slip is force times friction; feel and marking are pressure. A narrow ridge concentrates a modest force into a high pressure that seals, grips and, on skin, hurts; a broad flat jaw needs roughly an order of magnitude more force for the same pressure. State the opening, the contact you assumed, and the friction you used. Published dry static friction for printed PLA on itself spans roughly 0.12-0.38 (one printer read 0.25-0.31 on both faces) and PETG on itself roughly 0.13-0.21: use the low end when checking that a hold retains, the high end when checking that a hand can still insert it. Friction against the held object (a phone case, glass, paint) is unknown unless the context gives it; do not substitute the self-contact range for it.

Keep the bending in the layer plane. Filament laid along the strained length carries the bend; a bend that pulls layers apart works at a fraction of that strength (across-layer tensile strength is roughly half to nine-tenths of in-plane depending on grade and test) and parts with little warning. Turn the part, split it, or reshape the spring so its length lies in the layers. If a bend across layers is truly unavoidable, keep its strain well below the in-plane bands, give it generous roots, and bring its hard stop close. Make the spring from continuous wall loops: choose its thickness as whole extrusion widths and enough walls that no sparse infill sits inside the neck. Taper toward the tip where travel allows, fillet every root or curve continuously through it, and never hang a spring from a sharp internal corner.

Choose strain by duty first, then material. In the layer plane, as planning bands: held bent for months at room temperature, keep PLA to about 0.5% or less and PETG to about 1.4% or less, and prefer a shape whose rest state is unstrained so holding costs nothing; bent every day for hundreds to thousands of cycles, proven mechanisms commonly work at about 1.5-2.6% in PLA and about 2-3.4% in PETG; bent once to assemble, or touched only at the hard stop, PLA on one coupon-tested printer survived 3.3% once and ten times in both orientations without cracking, and proven PETG designs peak at about 4-4.3%. Treat those peaks as no-crack evidence, not proof of full spring-back: past roughly 3.3-3.4% PLA begins to whiten and take set in published printed-specimen testing, long before its published break elongation (about 12% in-plane for one current PLA grade), because break includes permanent deformation a spring cannot use. Older moulded-plastic snap allowances near 1-1.7% are not printed fracture limits; designing every spring to them produces weak, timid parts. Grade matters as much as polymer family: current cards put one PETG grade's tensile modulus near 2780 MPa and another's near 1810 MPa, so size force from the actual grade's card or an observed deflection (one printer's PLA measured about 2600 MPa, close to its 2580 MPa card), never from the family name alone.

Expect, in order: a sharp root whitens, yields and takes set; a bend across layers delaminates; a held bend creeps and its force fades; only then does a well-shaped in-plane spring crack. Design so the first failure you would meet is harmless and visible, and so the hard stop prevents the rest.

Heat changes the answer before it melts anything. PLA grades soften under load from roughly the mid-50s C (heat deflection about 54-57 C, glass transition about 60 C) and PETG grades from roughly the low 60s to about 70 C depending on grade and load (glass transition about 66-69 C); published creep tests already move faster after brief warming near 46 C. A sun-parked dashboard has been documented around 70 C within an hour. Judge by exposure and load together: a shaded, unloaded trim piece is not a loaded spring on a dashboard. For sun-exposed parts that must stay bent or carry load, neither PLA nor PETG is an honest default; prefer a higher-temperature filament the printer actually has, a rest state at zero strain while parked empty, and positive capture (lips, shelves, a latch) so friction alone never decides whether the object stays. Say plainly when the loaded filaments cannot do the thermal job instead of silently printing it anyway.

In the result, give the duty you designed for, how a hand operates it (where the fingers go and the force to open it at the tabs), the working and hard-stop strains and how you estimated them, the bite or spring force at the stated opening with its contact and friction assumptions, the rest strain, and the heat verdict. A force without its opening, or a strain without its duty, is not yet a claim.`;

export const FDM_CAPABILITY_GUIDANCE = `# Bridges and overhangs: useful capability without arbitrary bans

Load this reference only when the feature matters to the manufacturing decision. These are proposed planning bands, not manufacturer guarantees, support-generation settings, or automatic acceptance/rejection rules.

## Scope and terminology

The provisional baseline is an ordinary modern Bambu P-series-class FDM setup, a 0.4 mm nozzle, a suitable PLA profile, normal planar toolpaths, and effective part cooling. Actual printer/material/profile evidence takes priority. Do not transfer the same expectations unchanged to PETG, flexible materials, a different layer height, or a different cooling arrangement.

Angles in the proposed review bands are measured **from vertical**: a vertical wall is 0 degrees; a horizontal underside is 90 degrees. Source values retain their stated or unresolved convention as noted. Slicer controls and test models can use a different convention. Establish their convention before comparing or entering a value. For a simple planar slope, the angle from the build plate is 90 degrees minus the angle from vertical.

An overhang grows sideways from material below. A conventional bridge has extruded paths anchored at both ends. A disconnected island begins with no suitable underlying material or anchorage. They require different decisions.

## What the retrieved evidence establishes

- Prusa's current modeling documentation gives a general 45–60 degree range depending on nozzle/settings, and describes up to 75 degrees for its specifically named Nextruder/360-degree-cooling machines. That is evidence against a universal 45-degree limit. It does not certify 75 degrees on every Bambu printer. [C1]
- A Fab Academy 2026 hands-on comparison of Bambu P2S and H2S used matte-white PLA and reported 50 mm unsupported bridge strands without a visible problem. It also reported some drooping above 60 degrees on the overhang test. This is a useful documented result on particular geometry, not a population benchmark or proof of flat mating-surface accuracy. [C2]
- An MIT HTMAA 2025 P1S characterization reported no noticeable defects on its longest tested bridge, 20 mm, and explicitly left the actual maximum unmeasured. A largest passing sample is not the machine's limit. [C3]
- Bambu's PETG Basic V3.0 data sheet lists approximately 30 mm maximum bridging length and approximately 70 degrees maximum overhang; its PLA Tough+ V3.0 sheet lists 30 mm and 55 degrees. These are material-specific reference values. The retrieved sheets do not define the overhang angle convention or a bridge sag/finish acceptance criterion, so keep the angle values as reported rather than silently normalizing them. Do not assume the mechanical-specimen print conditions also describe these feature tests. [C4, C5]

The material sheets provide useful 30 mm reference points; the firsthand longer prints show why a published or configured maximum should not become a universal geometric prohibition. Filament formulation matters. Avoid a rule that all PLA must outperform all PETG.

## Proposed review bands

These bands decide how much attention to give a feature. They never force a flat design, a split, supports, or a calibration print by themselves.

| Feature on the provisional PLA setup | Working stance |
| --- | --- |
| Progressively supported overhang around 45–60 degrees | Keep an unsupported version as an ordinary candidate. Inspect local curvature, overlap, cooling, and required finish. |
| Overhang around 60–70 degrees | Retain the shape as a candidate; examine local layer height, geometry, cooling, and relevant prior results more closely. Modest support is also an ordinary option. |
| Overhang around 70 degrees or more | Require a stronger process/geometry justification to rely on a clean unsupported result. Consider a representative sample when its result would decide between substantially different plans. |
| Conventional bridge up to about 20 mm | Treat as a plausible ordinary candidate when anchors, toolpaths, and underside requirements are suitable. |
| Bridge roughly 20–50 mm | Keep bridging as a real design option. Pay more attention to actual unsupported path length, anchorage, width, cooling, and sag acceptance. |
| Bridge beyond about 50 mm | Keep it in the design space; seek relevant prior evidence or a small representative test before depending on its quality for an expensive or precise part. |

The 60–70-degree and 20–50-mm bands are deliberate engineering priors for this app. They are not claims that a manufacturer has validated the whole interval. A 12 mm bridge can be unacceptable for a tight sliding surface; a much longer one may be adequate above a noncritical cavity. Avoid turning these bands into a hidden \`max_bridge\` or \`max_overhang\` rejection threshold.

## A useful geometric check

For an idealized straight overhang at angle alpha from vertical, layer height h produces a lateral step:

\`step = h * tan(alpha)\`

Using a nominal extrusion width w, a simple projected overlap estimate is:

\`overlap_fraction = max(0, 1 - step / w)\`

For a 60-degree overhang and a 0.45 mm line width:

| Layer height | Lateral step | Nominal overlap |
| --- | --- | --- |
| 0.20 mm | 0.346 mm | About 23% |
| 0.12 mm | 0.208 mm | About 54% |

These values follow from geometry, not a printer test. The model omits bead shape, curved toolpaths, cooling, adhesion, and other effects. It explains why layer height can change the outlook; it cannot prove a print will succeed. Use the actual extrusion widths when known.

Ordinary overhang-layer reasoning does not prescribe the best bridge extrusion. OrcaSlicer's documented thick-bridge mode uses a line height equal to nozzle diameter and trades a rougher surface for stronger, more reliable bridges and potentially longer spans. Inspect the actual selected mode instead of assuming bridge height equals ordinary layer height. [C6]

Reducing layer height throughout a multicolor part can also increase the number of color-change layers. Prefer a local intervention when appropriate and re-slice the whole manufacturing plan to see the tradeoff.

## Local interventions to consider

Keep the intervention proportionate to the specific problem. Useful candidates include changing build orientation, adjusting only a hidden underside, replacing the top of a horizontal hole with a suitable printable roof while preserving its necessary clearance, using local adaptive layers, improving a bridge's anchors or extrusion direction, adding a small removable sacrificial feature, placing accessible support, or splitting at a sensible joint.

Preserve roundness where a mating shaft genuinely needs it. Preserve curves where they matter visually. An unremovable support inside a duct is not a valid plan. Do not trade away layer bonding to improve cooling without considering the part's mechanical job.

Treat the slicer's support-generation thresholds as policy settings, not measured capability. For example, OrcaSlicer's \`max_bridge_length\` decides which anchored spans tree supports leave unsupported. Its configured value does not establish what the machine can physically bridge. [C7]

## What to learn from physical prints

Record the feature and its conditions, not merely a global pass/fail label. Useful evidence includes:

- Largest tested span or angle, plus known failures and untested regions.
- Actual printer, filament identity, nozzle, layer/line profile, cooling, and build orientation.
- Bridge direction, width, anchors, and nearby geometry.
- Whether the criterion was survival, cosmetic quality, measured sag, fit, or load performance.

A small combined coupon at onboarding can complement the printed measuring tool, but it should be optional. Later, print a targeted sample when an important unknown would otherwise put a much larger print at risk. Routine geometry should not repeatedly trigger calibration work.

## Primary sources

[C1] Prusa, Modeling with 3D printing in mind:

https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135

[C2] FabLab Nagoya, Fab Academy 2026 Week 05, firsthand P2S/H2S characterization:

https://fabacademy.org/2026/labs/nagoya/assignments/week05/

[C3] Ryan Hoffman, MIT HTMAA 2025, firsthand P1S characterization:

https://fab.cba.mit.edu/classes/863.25/people/RyanHoffman/week3.html

[C4] Bambu PETG Basic Technical Data Sheet V3.0:

https://store.bblcdn.com/s1/default/cb94589bf7994fdcbfa833badefae9cd/Bambu_PETG_Basic_Technical_Data_Sheet.pdf

[C5] Bambu PLA Tough+ Technical Data Sheet V3.0:

https://store.bblcdn.com/s7/default/80a85371db2e40bda97069d283fed76c/BambuPLA_Tough_TechnicalData_Sheet_%282%29.pdf

[C6] OrcaSlicer bridge settings:

https://github.com/OrcaSlicer/OrcaSlicer/wiki/quality_settings_bridging

[C7] OrcaSlicer advanced support settings:

https://github.com/OrcaSlicer/OrcaSlicer/wiki/support_settings_advanced

All sources inspected 3 November 2026.`;

export const FDM_CAPABILITY_URI = "guidance://fdm/capability-guidance";

export const FDM_CAPABILITY_RESOURCE = { uri: FDM_CAPABILITY_URI, name: "FDM bridge and overhang guidance", mimeType: "text/markdown",
  description: "Planning bands and evidence for bridges and overhangs, for when one is consequential and there is no sufficiently specific measured capability available" };

/** How to choose each fit by what the interface has to do on a filament printer (Nov 10: 0.5 mm a side was right for a
 * drop-in bottle holder and would ruin a mic clamp). Sources are cited inline; the bands and the slot span are app priors. Served as the fdm_fit prompt and the fit-by-function resource so prompt-only workers read the same text. */
export const FDM_FIT_GUIDANCE = `# Choosing a fit by function on a filament printer

Read this whenever a printed part meets a real object or another part. It covers how to choose each fit and why it prints the way it does. The ranges here are starting points tied to a function, a feature size and a 0.4 mm nozzle. The person's result ("did it fit?") corrects them. There is no single fit number.

## Three things, kept apart per interface

1. **The object's true size**, how it was measured (calipers, a published dimension, a scan, a photo estimate), and how sure that size is.
2. **The print correction** for this printer, material and orientation. Pockets and holes print undersize, and walls stepped by layers differ from walls drawn in one layer.
3. **The design fit**, which comes only from what the interface has to do.

If the three fold into one number, a result like "0.5 mm per side and it was loose" teaches nothing reusable. Say which of the three the result corrects.

## Say what each interface has to do

Name the function in plain words, and infer it first from the object and how the part mounts. A wall holder that opens upward is a drop-in. A mount on a pole must not turn. A person will not say "grips". When the function is unclear and the answer changes the design, ask about behaviour: should it stay in when turned upside down, lift out with one hand, ever turn?

| Function | Band it tolerates (app prior) | What usually works |
| --- | --- | --- |
| Rests in, or drops in and lifts out | Forgiving: a few tenths of a millimetre either way | Plain clearance, a lead-in at the mouth |
| Slides | Moderate | Clearance plus enough engagement length that it does not rock |
| Locates without rattle | Tight | Small clearance with a chamfer or taper, or a flexure that takes up the slack |
| Grips so it does not slip or turn | Very tight: a few hundredths | Crush ribs, a split with a pinch screw, or a flexure. Never a bare number |
| Clamps closed with a screw | The clamp's travel | A split with a screw, sized so the screw's range covers the size's uncertainty |
| Snaps over | The snap's deflection | A snap whose arm flexes within its layers |
| Presses in to stay | Very tight, and it creeps | Crush ribs or a screw. A pure press is for light or short-lived loads |

The bands are deliberate priors for this app, not values from a cited source. When the size's uncertainty is wider than the function's band (for example, a scan or photo estimate for a grip), do not answer with a better number. Choose a mechanism that absorbs the difference, or ask for the one caliper measurement that settles it.

## Why filament prints fit the way they do

- **Holes print undersize.** Protolabs Network: "FDM often prints undersized vertical-axis holes." Each new layer is pressed onto the ones below. "The amount of undersize depends on the printer, slicing software, hole size and material." [F1] HydraRaptor gives two more causes. A hole drawn as a polygon has sides inside the circle, "shrinking it by cos(π / n)". And filament dragged round a corner "likes to take a short-cut", which its author judged the dominant effect on their own machines. [F6] Small holes suffer most, relative to their size. The slicer can correct holes and outer contours separately (OrcaSlicer's X-Y hole and contour compensation) and can rebuild round holes as polyholes. [F5] Check what the active profile applies before adding your own allowance, so it is not applied twice.
- **First layers flare.** The first layer spreads into an "elephant's foot" that "can impact the ability to assemble FDM parts". Protolabs Network suggests a 45° chamfer or radius on edges that touch the build plate. [F1] OrcaSlicer's elephant-foot compensation shrinks the first layers, and only when the object sits directly on the plate. [F5] A pocket's mouth or a rim that prints on the plate needs either the chamfer or that setting.
- **A hole lying on its side differs from one standing upright.** A vertical-axis hole is drawn as a circle in every layer and carries only the undersize above. A horizontal-axis hole cuts across the layers. Its top is an overhang that ends in a bridge: Protolabs Network notes that bridges "most often occur in horizontal-axis holes". [F1] So it sags, comes out short from top to bottom, and is stepped on its sides. For a round fit on its side, give the hole a teardrop or flat roof and keep the bearing faces at the sides, or turn the part. Any overhang guidance applies to that roof.
- **Engagement length matters.** A longer engagement keeps a slide from rocking and spreads a grip. A short one concentrates the load on a few layers and lets a part tilt within its clearance. This is design reasoning, not a sourced value.
- **Plastic creeps under a constant load.** Dogan (2022) found that printed polymers, PLA among them, "undergo significant changes in their dimensions under continuous loading conditions", and that material type, temperature and load level all mattered. [F9] A pure press fit or a constant clamp therefore loosens over weeks, and faster when warm. Where a part must hold for months, prefer a screw you can re-tighten or a snap that carries load only during assembly.
- **How the object yields matters too.** A squeezable bottle, a rigid pole and a rubber-sleeved cable want different fits. A soft object can take some interference. A rigid one makes the print take all of it. The same object is not one size for its whole life: a bottle full and nearly empty, a case new and worn, a strap stretched and relaxed present different sizes and stiffnesses. A fit that relies on the object giving way must work in its stiffest, largest state, and a fit that must retain must still retain in its smallest, softest state. This is design reasoning, not a sourced value.

## Mechanisms that absorb uncertainty

- **Crush ribs.** Small ribs inside a bore deform as the part is pressed in, so the part touches only the ribs. Hackaday calls them "far easier (and more forgiving)" than a full-bore press, and notes that "a 0.1 mm difference can have a noticeable effect" on a plain fit. [F7] In molding practice, three or more ribs along the hole deform at their narrow tips "without creating a lot of stress on the part". [F8] A crushed rib does not recover, so use ribs for parts assembled once, with light loads.
- **A split with a pinch screw.** A slot through one side of the bore with a screw across it. The screw's travel covers a range of sizes, and a screw can be re-tightened after creep. Use it for a pole, a tube or a handle whose size is a scan or photo estimate, and say the range it holds.
- **A flexure.** A thin arm or a sprung finger presses on the object. Use it to locate without rattle or to hold a soft object, where an exact size is unknown.
- **A snap.** Protolabs Network gives these rules for 3D-printed snaps:
  - Taper the beam toward the tip, because a constant-thickness beam strains most at the root.
  - Make the root fillet at least 0.5 times the base thickness, and the beam at least 5 mm wide.
  - Avoid cantilevers built vertically in the Z direction.
  - Deflect the snap only during assembly, not in service.
  - Leave 0.5 mm of tolerance for FDM snap-fit connectors. The page does not say whether that is per side. [F2]

  In short, a snap arm flexes within its layers, never across them.

## Starting clearances for a plain fit

The sources disagree, and none gives the nozzle, material or whether a value is per side:
- Prusa says an Original Prusa "will be accurate to at least 0.2 mm". Its first value for movable parts is "at least 0.3 mm", and it says there is no universal value. [F3]
- The University of Florida makerspace's rule of thumb for parts printed separately on Prusa MK4 and XL printers is:
  - 0.30–0.40 mm for loose parts such as covers;
  - 0.20–0.25 mm for standard sliding fits (tabs, rails, enclosures);
  - 0.15–0.20 mm for snug or alignment fits, "very dependent on surface qualities". [F4]

Read these as gaps between facing surfaces on a 0.4 mm nozzle, and treat that reading as an assumption. Use them only where a plain clearance is the right mechanism: loose or sliding fits, and locating fits with a chamfer. A larger feature, a hole on its side or an uncorrected first layer needs more. For a grip or a press, these numbers are not the answer. Use a mechanism above.

## This printer's own readings come first

When the context supplies fit observations from this printer, filament and orientation, they override the starting points above for the same kind of feature. Keep their scope: an observation about one pin and hole printed together measures the pair, not the hole alone. For scale only (one 0.4 mm-nozzle PLA setup, not a rule for other printers): crush ribs at 0.15 mm per side pressed in and stayed for good while 0.30 mm per side would not go in by hand on a 20 mm pin; an 8 mm printed pin turned firmly in a hole drawn at 8.10 mm; and across the layers a 0.4 mm total gap was firm while 0.6 mm was free. Another printer starts from the cited values and its own first result.

## Getting in and staying

- Size a pocket to the widest section the object passes through on the way in, not to its bounding box or the scan's average.
- Derive a pocket's outline by offsetting the object's own outline outward by the clearance, so each pocket corner radius is the object's plus the clearance. A pocket corner rounder than that cuts into the object's corner even when the width and length clear; a sharper one is safe, or relieve the corner. Check the clearance at the corners, not only across the flats.
- Put a lead-in chamfer at the mouth. Prusa notes that a chamfer on edges that slot together saves effort when assembling. [F3]
- Over a span of more than about 150 mm, make wall-screw holes slots so the part can be placed despite measuring error. This is an app prior, not a sourced value.

## Report each interface

In the result, give each interface its function, the size used and its source and uncertainty, the print correction assumed, and the fit chosen (a clearance or interference per side, or the mechanism and the range of sizes it holds), with why. When the person reports how it fitted, change the value their result corrects, and say which one.

## Sources

[F1] Protolabs Network (Hubs), How to design parts for FDM 3D printing:

https://www.hubs.com/knowledge-base/how-design-parts-fdm-3d-printing/

[F2] Protolabs Network (Hubs), How do you design snap-fit joints for 3D printing?:

https://www.hubs.com/knowledge-base/how-design-snap-fit-joints-3d-printing/

[F3] Prusa Knowledge Base, Modeling with 3D printing in mind:

https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135

[F4] Marston Makerspace, University of Florida, Designing for 3D Printing Tolerances on the MK4 and XL:

https://makerspace.uflib.ufl.edu/services/3dprocess/recommended-software-for-3d-printing/designing-for-3d-printing-tolerances-on-the-mk4-and-xl/

[F5] OrcaSlicer wiki, Precision (X-Y hole and contour compensation, elephant foot compensation, polyholes):

https://www.orcaslicer.com/wiki/print_settings/quality/quality_settings_precision

[F6] nophead, HydraRaptor: Polyholes (5 February 2011):

https://hydraraptor.blogspot.com/2011/02/polyholes.html

[F7] Donald Papp, Hackaday, Adding Crush Ribs To 3D Printed Parts For A Better Press Fit (15 October 2020):

https://hackaday.com/2020/10/15/adding-crush-ribs-to-3d-printed-parts-for-a-better-press-fit/

[F8] Protolabs, Crush Rib Design Guidelines for Injection Molding:

https://www.protolabs.com/resources/design-tips/adding-crush-ribs-to-molded-parts/

[F9] O. Dogan, Short-term Creep Behaviour of Different Polymers Used in Additive Manufacturing under Different Thermal and Loading Conditions, Strojniški vestnik – Journal of Mechanical Engineering 68 (7–8), 2022, 451–460, doi:10.5545/sv-jme.2022.191 (abstract):

https://ojs30.sv-jme.eu/index.php/sv-jme/article/view/191

All sources inspected 10 November 2026.`;

export const FDM_FIT_URI = "guidance://fdm/fit-by-function";

export const FDM_FIT_RESOURCE = { uri: FDM_FIT_URI, name: "FDM fit by function", mimeType: "text/markdown",
  description: "How to choose each fit where a printed part meets a real object or another part: by what the interface has to do, with why filament prints fit the way they do, mechanisms that absorb size uncertainty, and cited starting points" };

export const DESIGN_PROMPTS: DesignPrompt[] = [
  CAD_DESIGN_PROMPT,
  { name: "fdm_design", title: "Design for FDM printing", text: FDM_CORE,
    description: "Persistent instructions for every design or model-editing task: plan how the object prints as part of the design, using the actual printer, filaments and slice." },
  { name: "fdm_fit", title: "Choosing a fit by function", text: FDM_FIT_GUIDANCE,
    description: "Add whenever a part meets a real object or another part: choose each fit by what that interface has to do, with why filament prints fit the way they do, mechanisms that absorb size uncertainty, and cited starting points. The same text is the fit-by-function resource." },
  { name: "fdm_flexures", title: "Parts that flex, grip and snap", text: FDM_FLEXURES,
    description: "Add whenever a part must flex, grip, snap, clip, spring, or hold something by bending: compliant architectures, strain chosen by duty, material and layer direction, bite, heat and creep." },
  { name: "fdm_multicolor", title: "Multicolour and support materials", text: FDM_MULTICOLOR,
    description: "Add when several colours or support materials share a print: filament transitions, colour placement, plate scheduling and flushing." },
  { name: "fdm_assembly", title: "Splits, inserts and joints", text: FDM_ASSEMBLY,
    description: "Add when a split, accent insert, joint or printed fastener could materially improve the result." },
  { name: "fdm_after_slice", title: "Review a slice", text: FDM_AFTER_SLICE,
    description: "A separate review turn after a candidate has been sliced, before presenting the manufacturing recommendation: keep, revise, or validate one specific uncertainty." },
];

const SLICER_NAMES: Record<string, string> = {
  bambustudio: "Bambu Studio", orcaslicer: "OrcaSlicer", "orcaslicer-bambulab": "FULU OrcaSlicer-bambulab",
  "orca-slicer-api": "the remote OrcaSlicer service (orca-slicer-api)", prusaslicer: "PrusaSlicer", cura: "Cura", slic3r: "Slic3r",
};

/**
 * How this server's configured slicer orients, makes supports and checks a slice: the slicer-specific half of a
 * design pass's print plan (the fdm_slicing prompt). `capabilities` is what slice_stl applies on that backend, as
 * counterpart_printer_info reports it.
 */
export function slicingGuidance(slicerType: string, capabilities: { supports: boolean; orient: boolean }): string {
  const slicer = SLICER_NAMES[slicerType] ?? slicerType;
  const lines = [
    `How this printer MCP slices. Its slicer is ${slicer}.`,
    "- When they could change a decision, read the printer's loaded filaments with get_printer_filaments and its slicing settings with get_slice_settings.",
    "- To check a consequential choice, slice a checkpoint with slice_stl and read its structured slicer_result (return code, error and each plate's warning), not only the file path. A checkpoint is only a check: the print slices the exported model again.",
    capabilities.orient
      ? `- Orientation: slice_stl with orient true lets ${slicer}'s own auto-orient choose how an STL sits on the bed. It keeps overhang area low; it does not check cantilevers. To see what it chooses, slice the checkpoint with orient true. When a print is oriented this way, don't promise a particular orientation on the bed: the slicer chooses it.`
      : `- Orientation: ${slicer} doesn't auto-orient here. An STL prints in the orientation it's exported in.`,
    capabilities.supports
      ? "- Supports: set enable_support on every slice_stl call. With enable_support true it generates supports in the style support_type names (tree(auto) or normal(auto)); with false it generates none; left out, the process preset's own setting applies. Slice the checkpoint with enable_support set the way the print will be sliced. A print gets the supports it was sliced with: print the sliced file itself, or slice the print with slice_stl and the same enable_support and support_type. print_3mf's own slicing of a file that isn't sliced yet takes no support settings; it uses the process profile's."
      : `- Supports: ${slicer} takes no support settings from slice_stl here: whether it generates supports is its configured profile's own setting. Slice a checkpoint to see what that profile does before modeling any support yourself.`,
  ];
  return lines.join("\n");
}

export const FDM_SLICING_PROMPT = { name: "fdm_slicing", title: "How this MCP slices",
  description: "Add to every design or model-editing task: how this server's slicer orients a model and generates supports, and how to check a choice with a checkpoint slice." };

export const SERVER_INSTRUCTIONS = "When designing or editing a model to print, apply the fdm_design prompt and the fdm_slicing prompt. Add fdm_fit whenever a part meets a real object or another part, to choose each fit by what that interface has to do. Add fdm_flexures whenever a part must flex, grip, snap, clip, spring, or hold something by bending. Add fdm_multicolor when several colours or support materials share a print, fdm_assembly when a split, joint or printed fastener could help, and fdm_after_slice as a separate review turn after a candidate has been sliced, before presenting the manufacturing recommendation. Read " + FDM_CAPABILITY_URI + " when a bridge or overhang is consequential and there is no sufficiently specific measured capability available. Read " + FDM_FIT_URI + " for the same fit guidance as the fdm_fit prompt, in resource form.";
