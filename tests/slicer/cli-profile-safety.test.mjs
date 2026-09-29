import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { STLManipulator } from '../../dist/stl/stl-manipulator.js';
import { flattenForCli, detectProfilesRoot } from '../../dist/slicer/profile-flatten.js';

// Exercise profile preparation and the emitted CLI arguments; never run a real slicer.
async function fixture(t, slicerType = 'bambustudio') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-profile-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profiles = path.join(root, 'BambuStudio.app', 'Contents', 'Resources', 'profiles');
  const bbl = path.join(profiles, 'BBL');
  for (const kind of ['machine', 'process', 'filament']) await fs.mkdir(path.join(bbl, kind), { recursive: true });
  await fs.writeFile(path.join(bbl, 'cli_config.json'), JSON.stringify({
    printer: { 'Bambu Lab SAFETY': { machine_limits: { cli_safe_acceleration_x: '6000,6000' } } },
  }));
  const write = async (kind, value) => {
    const file = path.join(bbl, kind, `${value.name}.json`);
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  };
  await write('machine', { name: 'SAFETY base', nozzle_diameter: ['0.4'], machine_start_gcode: 'GENERIC' });
  await write('machine', { name: 'SAFETY start', machine_start_gcode: 'M620 S0A ; correct machine' });
  const machine = await write('machine', {
    name: 'Bambu Lab SAFETY 0.4 nozzle', inherits: 'SAFETY base', include: ['SAFETY start'],
    default_print_profile: 'SAFETY process', default_filament_profile: ['SAFETY filament'],
  });
  await write('process', { name: 'SAFETY process base', layer_height: '0.2', wall_loops: '2' });
  const processFile = await write('process', { name: 'SAFETY process', inherits: 'SAFETY process base' });
  const filament = await write('filament', { name: 'SAFETY filament', filament_type: ['PLA'], nozzle_temperature: ['220'] });
  const executable = path.join(root, 'BambuStudio.app', 'Contents', 'MacOS', 'BambuStudio');
  const capture = path.join(root, 'args.json');
  // The fake CLI cannot import jszip; it copies a real sliced-project archive.
  const slicedZip = new JSZip();
  slicedZip.file('Metadata/plate_1.gcode', '; fixture plate gcode\nG28\n');
  const slicedFixture = path.join(root, 'fixture_sliced.3mf');
  await fs.writeFile(slicedFixture, await slicedZip.generateAsync({ type: 'nodebuffer' }));
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, `#!${process.execPath}\nconst fs = require('fs'); const path = require('path'); const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(args)); fs.copyFileSync(${JSON.stringify(slicedFixture)}, path.join(args[args.indexOf('--outputdir') + 1], args[args.indexOf('--export-3mf') + 1]));\n`, { mode: 0o755 });
  const saved = Object.fromEntries(['BAMBU_PROFILES_ROOT', 'BAMBU_SLICER_PROFILE_DIRS', 'BAMBU_CLI_FLATTEN'].map(k => [k, process.env[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  process.env.BAMBU_PROFILES_ROOT = profiles;
  process.env.BAMBU_SLICER_PROFILE_DIRS = bbl;
  delete process.env.BAMBU_CLI_FLATTEN;
  const manipulator = new STLManipulator(path.join(root, 'out'));
  const stl = path.join(root, 'model.stl');
  await fs.writeFile(stl, 'fixture STL (only the fake CLI reads it)');
  // sliceSTL keeps its legacy (…, printerPreset, filamentProfile) order; Bambu options are the 8th argument.
  const slice = (options = {}, profile, input = stl) => manipulator.sliceSTL(input, slicerType, executable, profile, undefined, 'Bambu Lab SAFETY 0.4 nozzle', undefined, options);
  const args = async () => JSON.parse(await fs.readFile(capture, 'utf8'));
  const loaded = async () => { const a = await args(); return a[a.indexOf('--load-filaments') + 1].split(';'); };
  const project = async (count) => {
    const zip = new JSZip();
    zip.file('Metadata/project_settings.config', JSON.stringify({ filament_settings_id: Array(count).fill('Foreign @BBL OTHER'), filament_type: Array(count).fill('PLA') }));
    const file = path.join(root, 'project.3mf');
    await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    return file;
  };
  return { root, profiles, write, machine, processFile, filament, executable, stl, slice, args, loaded, capture, project };
}

for (const slicerType of ['bambustudio', 'orcaslicer', 'orcaslicer-bambulab']) {
  for (const customProcess of [false, true]) {
    test(`${slicerType} rejects a missing machine before execution${customProcess ? ' with a custom process' : ''}`, async t => {
      const f = await fixture(t, slicerType);
      await fs.unlink(f.machine);
      const profile = path.join(f.root, 'custom.json');
      await fs.writeFile(profile, JSON.stringify({ name: 'Custom', layer_height: '0.16' }));
      for (const input of [f.stl, await f.project(1)]) {
        await assert.rejects(f.slice({}, customProcess ? profile : undefined, input), /Printer profile.*SAFETY.*not found/);
        await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
      }
    });
  }

  // Generic OrcaSlicer without a Bambu preset keeps its non-Bambu profile path in this multi-printer server.
  if (slicerType !== 'orcaslicer') test(`${slicerType} rejects an omitted machine selection before execution`, async t => {
    const f = await fixture(t, slicerType);
    const manipulator = new STLManipulator(path.join(f.root, 'missing-selection'));
    await assert.rejects(manipulator.sliceSTL(f.stl, slicerType, f.executable, f.processFile), /[Pp]rinter.*required/);
    await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
  });

  test(`${slicerType} cannot borrow a machine from another installation`, async t => {
    const f = await fixture(t, slicerType);
    const selected = path.join(f.root, 'selected-profiles');
    await fs.mkdir(path.join(selected, 'BBL', 'machine'), { recursive: true });
    // The unrelated tree still contains the requested machine.
    process.env.BAMBU_PROFILES_ROOT = selected;
    await assert.rejects(f.slice(), /Printer profile.*SAFETY.*not found/);
    await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
  });

  test(`${slicerType} loads inherited default process and filament profiles`, async t => {
    const f = await fixture(t, slicerType);
    // FULU's P1S leaf inherits these selections from the machine family.
    await f.write('machine', { name: 'SAFETY base', nozzle_diameter: ['0.4'],
      default_print_profile: 'SAFETY process', default_filament_profile: ['SAFETY filament'] });
    await f.write('machine', { name: 'Bambu Lab SAFETY 0.4 nozzle', inherits: 'SAFETY base', include: ['SAFETY start'] });
    await f.slice();
    const args = await f.args();
    const processFile = args[args.indexOf('--load-settings') + 1].split(';')[1];
    assert.equal(JSON.parse(await fs.readFile(processFile, 'utf8')).layer_height, '0.2');
    assert.notEqual(args.indexOf('--load-filaments'), -1, 'inherited defaults must be supplied explicitly');
    assert.deepEqual(JSON.parse(await fs.readFile((await f.loaded())[0], 'utf8')).nozzle_temperature, ['220']);
  });

  test(`${slicerType} preserves custom dependencies from configured user profile directories`, async t => {
    const f = await fixture(t, slicerType);
    const user = path.join(f.root, 'user-BBL');
    for (const kind of ['process', 'filament']) await fs.mkdir(path.join(user, kind), { recursive: true });
    await fs.writeFile(path.join(user, 'process', 'My process base.json'), JSON.stringify({
      name: 'My process base', inherits: 'SAFETY process', layer_height: '0.12', wall_loops: '5',
    }));
    await fs.writeFile(path.join(user, 'filament', 'My PETG.json'), JSON.stringify({
      name: 'My PETG', inherits: 'SAFETY filament', filament_type: ['PETG'], nozzle_temperature: ['250'], filament_id: 'my-petg',
    }));
    process.env.BAMBU_SLICER_PROFILE_DIRS = user;
    const custom = path.join(f.root, 'custom.json');
    for (const selection of [{ default_filament_profile: ['My PETG'] }, { filament_ids: ['my-petg'] }]) {
      await fs.writeFile(custom, JSON.stringify({ name: 'My custom', inherits: 'My process base', wall_loops: '7', ...selection }));
      await f.slice({}, custom);
      const args = await f.args();
      const [machineFile, processFile] = args[args.indexOf('--load-settings') + 1].split(';');
      assert.equal(JSON.parse(await fs.readFile(machineFile, 'utf8')).machine_start_gcode, 'M620 S0A ; correct machine');
      const config = JSON.parse(await fs.readFile(processFile, 'utf8'));
      assert.equal(config.layer_height, '0.12');
      assert.equal(config.wall_loops, '7');
      assert.deepEqual(JSON.parse(await fs.readFile((await f.loaded())[0], 'utf8')).nozzle_temperature, ['250']);
    }
  });

  test(`${slicerType} cannot resolve missing machine ancestors from user process profiles`, async t => {
    const f = await fixture(t, slicerType);
    const user = path.join(f.root, 'user-BBL');
    await fs.mkdir(path.join(user, 'process'), { recursive: true });
    await fs.copyFile(path.join(f.profiles, 'BBL', 'machine', 'SAFETY base.json'), path.join(user, 'process', 'SAFETY base.json'));
    await fs.unlink(path.join(f.profiles, 'BBL', 'machine', 'SAFETY base.json'));
    process.env.BAMBU_SLICER_PROFILE_DIRS = user;
    await assert.rejects(f.slice(), /SAFETY base.*not found/);
    await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
  });

  for (const invalid of ['null', '{broken', JSON.stringify({ name: 'Bambu Lab OTHER 0.4 nozzle' })]) {
    test(`${slicerType} rejects invalid machine contents: ${invalid}`, async t => {
      const f = await fixture(t, slicerType);
      await fs.writeFile(f.machine, invalid);
      await assert.rejects(f.slice(), /[Pp]rinter profile.*SAFETY/);
      await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
    });
  }

  if (slicerType === 'bambustudio') continue; // Existing tests cover its full preparation path below.

  test(`${slicerType} resolves machine G-code and preserves custom process and every filament slot`, async t => {
    const f = await fixture(t, slicerType);
    await f.write('process', { name: 'SAFETY process base', layer_height: '0.2', layer_gcode: 'G92 E0\n; next layer' });
    const custom = path.join(f.root, 'custom.json');
    await fs.writeFile(custom, JSON.stringify({ name: 'Custom', inherits: 'SAFETY process', wall_loops: '7' }));
    await f.slice({ loadFilaments: f.filament }, custom, await f.project(3));
    const args = await f.args();
    const [machineFile, processFile] = args[args.indexOf('--load-settings') + 1].split(';');
    const machine = JSON.parse(await fs.readFile(machineFile, 'utf8'));
    assert.equal(machine.machine_start_gcode, 'M620 S0A ; correct machine');
    assert.equal(machine.cli_safe_acceleration_x, '6000,6000');
    const processConfig = JSON.parse(await fs.readFile(processFile, 'utf8'));
    assert.equal(processConfig.wall_loops, '7');
    assert.equal(processConfig.layer_height, '0.2');
    if (slicerType === 'orcaslicer') {
      assert.equal(processConfig.use_relative_e_distances, '0');
      assert.equal(processConfig.layer_gcode, '; next layer');
    }
    assert.equal((await f.loaded()).length, 3);
    for (const file of await f.loaded()) {
      const filament = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.deepEqual(filament.nozzle_temperature, ['220']);
      assert.deepEqual(filament.filament_colour, ['#00AE42']);
    }
  });

  if (slicerType === 'orcaslicer') {
    test('orcaslicer keeps absolute-extrusion normalization when the machine owns layer G-code', async t => {
      const f = await fixture(t, slicerType);
      const machine = JSON.parse(await fs.readFile(f.machine, 'utf8'));
      await fs.writeFile(f.machine, JSON.stringify({ ...machine, use_relative_e_distances: '1', layer_change_gcode: 'G92 E0\n; machine layer' }));
      await f.write('process', { name: 'SAFETY process base', layer_height: '0.2', layer_change_gcode: 'G92 E0\n; process layer' });
      await f.slice({ loadFilaments: f.filament });
      const args = await f.args();
      const [machineFile, processFile] = args[args.indexOf('--load-settings') + 1].split(';');
      const loadedMachine = JSON.parse(await fs.readFile(machineFile, 'utf8'));
      const loadedProcess = JSON.parse(await fs.readFile(processFile, 'utf8'));
      assert.equal(loadedMachine.use_relative_e_distances, '0');
      assert.equal(loadedMachine.layer_change_gcode, '; machine layer');
      assert.equal(loadedProcess.layer_change_gcode, undefined, 'machine-owned keys stay out of the process');
      assert.equal(loadedProcess.use_relative_e_distances, undefined);
    });
  }

  for (const missing of ['SAFETY base.json', 'SAFETY start.json', '../cli_config.json']) {
    test(`${slicerType} rejects missing machine dependency ${missing}`, async t => {
      const f = await fixture(t, slicerType);
      await fs.unlink(path.join(f.profiles, 'BBL', 'machine', missing));
      await assert.rejects(f.slice(), /SAFETY base|SAFETY start|cli_config/);
      await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
    });
  }

  test(`${slicerType} rejects a partial filament list before CLI execution`, async t => {
    const f = await fixture(t, slicerType);
    await assert.rejects(f.slice({ loadFilaments: `${f.filament};${f.filament}` }, undefined, await f.project(3)), /filament.*3|3.*filament/i);
    await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
  });
}

test('bundled profiles resolve include G-code with flatten flag unset or false', async t => {
  const f = await fixture(t);
  for (const flag of [undefined, 'false']) {
    if (flag === undefined) delete process.env.BAMBU_CLI_FLATTEN; else process.env.BAMBU_CLI_FLATTEN = flag;
    await f.slice();
    const args = await f.args();
    const machine = args[args.indexOf('--load-settings') + 1].split(';')[0];
    assert.equal(JSON.parse(await fs.readFile(machine, 'utf8')).machine_start_gcode, 'M620 S0A ; correct machine');
  }
});

test('missing machine include prevents CLI execution', async t => {
  const f = await fixture(t);
  process.env.BAMBU_CLI_FLATTEN = 'true';
  await fs.unlink(path.join(f.profiles, 'BBL', 'machine', 'SAFETY start.json'));
  await assert.rejects(f.slice(), /includes.*SAFETY start/);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

test('an unreadable filament is rejected rather than removed from its position', async t => {
  const f = await fixture(t);
  process.env.BAMBU_CLI_FLATTEN = 'true';
  await assert.rejects(f.slice({ loadFilaments: `${f.filament};${path.join(f.root, 'missing.json')}` }), /filament|missing.json/i);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

test('missing named default filaments are rejected instead of shifting later slots', async t => {
  const f = await fixture(t);
  const machine = JSON.parse(await fs.readFile(f.machine, 'utf8'));
  machine.default_filament_profile = ['SAFETY missing', 'SAFETY filament'];
  await fs.writeFile(f.machine, JSON.stringify(machine));
  await assert.rejects(f.slice(), /filament.*SAFETY missing/i);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

test('bundled leaf settings come from the selected profile tree', async t => {
  const f = await fixture(t);
  const activeRoot = path.join(f.root, 'selected-profiles');
  await fs.cp(f.profiles, activeRoot, { recursive: true });
  const machinePath = path.join(activeRoot, 'BBL', 'machine', 'Bambu Lab SAFETY 0.4 nozzle.json');
  const machine = JSON.parse(await fs.readFile(machinePath, 'utf8'));
  machine.include = ['SAFETY selected start'];
  await fs.writeFile(machinePath, JSON.stringify(machine));
  await fs.writeFile(path.join(activeRoot, 'BBL', 'machine', 'SAFETY selected start.json'), JSON.stringify({ name: 'SAFETY selected start', machine_start_gcode: 'M620 S0A ; selected tree' }));
  process.env.BAMBU_PROFILES_ROOT = activeRoot;
  await f.slice();
  const args = await f.args();
  const loadedMachine = args[args.indexOf('--load-settings') + 1].split(';')[0];
  assert.equal(JSON.parse(await fs.readFile(loadedMachine, 'utf8')).machine_start_gcode, 'M620 S0A ; selected tree');
});

test('custom process inheritance preserves its overrides while flattening the machine', async t => {
  const f = await fixture(t);
  // A custom preset must not inherit the parent's system provenance along
  // with its settings, whether or not it explicitly declares from: User.
  await f.write('process', { name: 'SAFETY process', from: 'system', inherits: 'SAFETY process base' });
  const profile = path.join(f.root, 'custom-process.json');
  for (const from of [undefined, 'User']) {
    await fs.writeFile(profile, JSON.stringify({ name: 'Custom process', from, inherits: 'SAFETY process', wall_loops: '7' }));
    await f.slice({}, profile);
    const args = await f.args();
    const [machineFile, processFile] = args[args.indexOf('--load-settings') + 1].split(';');
    assert.equal(JSON.parse(await fs.readFile(machineFile, 'utf8')).machine_start_gcode, 'M620 S0A ; correct machine');
    const config = JSON.parse(await fs.readFile(processFile, 'utf8'));
    assert.equal(config.wall_loops, '7');
    assert.equal(config.layer_height, '0.2');
    assert.equal(config.name, 'Custom process');
    assert.equal(config.inherits, 'SAFETY process');
    assert.equal(config.print_settings_id, 'SAFETY process');
  }
});

test('an explicit bundled process retains the same leaf identity as the default preset', async t => {
  const f = await fixture(t);
  await f.write('process', { name: 'SAFETY process', inherits: 'SAFETY process base', wall_loops: '5', layer_height: '0.16' });
  const readProcess = async () => {
    const args = await f.args();
    return JSON.parse(await fs.readFile(args[args.indexOf('--load-settings') + 1].split(';')[1], 'utf8'));
  };
  await f.slice();
  const defaultProcess = await readProcess();
  for (const input of [f.stl, await f.project(3)]) {
    await f.slice({ loadFilaments: f.filament }, f.processFile, input);
    const explicitProcess = await readProcess();
    assert.equal(explicitProcess.name, 'SAFETY process');
    assert.equal(explicitProcess.inherits, 'SAFETY process');
    assert.equal(explicitProcess.print_settings_id, 'SAFETY process');
    assert.equal(explicitProcess.wall_loops, '5');
    assert.equal(explicitProcess.layer_height, '0.16');
    // Explicit preparation adds type; preserving provenance must keep that
    // prepared content instead of reloading the original bundled JSON.
    assert.deepEqual(explicitProcess, { ...defaultProcess, type: 'process' });
  }
});

test('standalone custom process and filament settings survive alongside a resolved machine', async t => {
  const f = await fixture(t);
  const profile = path.join(f.root, 'standalone-process.json');
  const filament = path.join(f.root, 'standalone-filament.json');
  await fs.writeFile(profile, JSON.stringify({ name: 'Standalone process', from: 'User', layer_height: '0.12', wall_loops: '9' }));
  await fs.writeFile(filament, JSON.stringify({ name: 'Standalone filament', from: 'User', filament_type: ['PETG'], nozzle_temperature: ['250'] }));
  await f.slice({ loadFilaments: filament }, profile);
  const args = await f.args();
  const [machineFile, processFile] = args[args.indexOf('--load-settings') + 1].split(';');
  assert.equal(JSON.parse(await fs.readFile(machineFile, 'utf8')).machine_start_gcode, 'M620 S0A ; correct machine');
  assert.equal(JSON.parse(await fs.readFile(processFile, 'utf8')).wall_loops, '9');
  assert.deepEqual(JSON.parse(await fs.readFile((await f.loaded())[0], 'utf8')), {
    name: 'Standalone filament', from: 'User', filament_type: ['PETG'], nozzle_temperature: ['250'],
    filament_colour: ['#00AE42'],
  });
});

test('an explicit filament override replaces unresolved defaults in a custom process', async t => {
  const f = await fixture(t);
  const profile = path.join(f.root, 'foreign-defaults.json');
  await fs.writeFile(profile, JSON.stringify({ name: 'Custom process', inherits: 'SAFETY process', default_filament_profile: ['Foreign missing filament'] }));
  await f.slice({ loadFilaments: f.filament }, profile);
  assert.equal((await f.loaded()).length, 1);
});

test('explicit repeated filament paths retain every positional slot', async t => {
  const f = await fixture(t);
  await f.slice({ loadFilaments: `${f.filament};${f.filament};${f.filament}` });
  assert.equal((await f.loaded()).length, 3);
});

test('a single filament override replaces all twelve declared project slots', async t => {
  const f = await fixture(t);
  await f.slice({ loadFilaments: f.filament }, undefined, await f.project(12));
  const loaded = await f.loaded();
  assert.equal(loaded.length, 12);
  for (const file of loaded) assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).nozzle_temperature, ['220']);
});

test('a partial multi-filament override is rejected before slicing a larger project', async t => {
  const f = await fixture(t);
  await assert.rejects(f.slice({ loadFilaments: `${f.filament};${f.filament}` }, undefined, await f.project(3)), /filament.*3|3.*filament/i);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

test('include templates resolve inherited and nested settings', async t => {
  const f = await fixture(t);
  await f.write('machine', { name: 'SAFETY nested', inherits: 'SAFETY start', include: ['SAFETY end'] });
  await f.write('machine', { name: 'SAFETY end', machine_end_gcode: 'M104 S0 ; correct end' });
  await f.write('machine', { name: 'Bambu Lab SAFETY 0.4 nozzle', inherits: 'SAFETY base', include: ['SAFETY nested'] });
  const result = await flattenForCli({ machineLeaf: 'Bambu Lab SAFETY 0.4 nozzle', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out') });
  const machine = JSON.parse(await fs.readFile(result.machinePath, 'utf8'));
  assert.equal(machine.machine_start_gcode, 'M620 S0A ; correct machine');
  assert.equal(machine.machine_end_gcode, 'M104 S0 ; correct end');
});

test('mixed include and inherits cycles reject instead of retaining generic G-code', async t => {
  const f = await fixture(t);
  await f.write('machine', { name: 'SAFETY start', inherits: 'SAFETY loop' });
  await f.write('machine', { name: 'SAFETY loop', include: ['SAFETY start'] });
  await assert.rejects(flattenForCli({ machineLeaf: 'Bambu Lab SAFETY 0.4 nozzle', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out') }), /cycle/i);
});

test('malformed include references reject instead of retaining generic G-code', async t => {
  const f = await fixture(t);
  for (const include of [42, [42], ['']]) {
    await f.write('machine', { name: 'Bambu Lab SAFETY 0.4 nozzle', inherits: 'SAFETY base', include });
    await assert.rejects(flattenForCli({ machineLeaf: 'Bambu Lab SAFETY 0.4 nozzle', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out') }), /include/i);
  }
});

test('custom overrides inheriting the same parent keep separate immutable output files', async t => {
  const f = await fixture(t);
  const opts = { machineLeaf: 'Bambu Lab SAFETY 0.4 nozzle', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out') };
  const first = await flattenForCli({ ...opts, sourceProfiles: { process: { name: 'Custom', inherits: 'SAFETY process', wall_loops: '5' } } });
  const second = await flattenForCli({ ...opts, sourceProfiles: { process: { name: 'Custom', inherits: 'SAFETY process', wall_loops: '9' } } });
  assert.notEqual(first.processPath, second.processPath);
  assert.equal(JSON.parse(await fs.readFile(first.processPath, 'utf8')).wall_loops, '5');
  assert.equal(JSON.parse(await fs.readFile(second.processPath, 'utf8')).wall_loops, '9');
});

for (const [layout, binary, profiles, slicerType = 'bambustudio'] of [
  ['Windows portable', 'portable/BambuStudio.exe', 'portable/resources/profiles'],
  ['Linux prefix', 'prefix/bin/bambu-studio', 'prefix/share/BambuStudio/profiles'],
  ['Orca Linux prefix', 'prefix/bin/orca-slicer', 'prefix/share/OrcaSlicer/profiles', 'orcaslicer'],
  ['FULU Linux prefix', 'prefix/bin/orca-slicer', 'prefix/share/OrcaSlicer/resources/profiles', 'orcaslicer-bambulab'],
  ['Orca macOS bundle', 'OrcaSlicer.app/Contents/MacOS/OrcaSlicer', 'OrcaSlicer.app/Contents/Resources/profiles', 'orcaslicer'],
  ['FULU Windows portable', 'portable/orca-slicer.exe', 'portable/resources/profiles', 'orcaslicer-bambulab'],
]) {
  test(`${layout} profile discovery follows the active executable`, async t => {
    const f = await fixture(t);
    const executable = path.join(f.root, binary);
    const root = path.join(f.root, profiles);
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.copyFile(f.executable, executable);
    await fs.chmod(executable, 0o755);
    await fs.cp(f.profiles, root, { recursive: true });
    delete process.env.BAMBU_PROFILES_ROOT;
    process.env.BAMBU_SLICER_PROFILE_DIRS = ''; // hermetic: never search the real user profile tree
    assert.equal(await fs.realpath(detectProfilesRoot(executable, slicerType)), await fs.realpath(root));
    const manipulator = new STLManipulator(path.join(f.root, 'portable-out'));
    await manipulator.sliceSTL(f.stl, slicerType, executable, undefined, undefined, 'Bambu Lab SAFETY 0.4 nozzle');
    const args = await f.args();
    const machineFile = args[args.indexOf('--load-settings') + 1].split(';')[0];
    assert.equal(JSON.parse(await fs.readFile(machineFile, 'utf8')).machine_start_gcode, 'M620 S0A ; correct machine');
  });
}

test('an unavailable active profile tree cannot silently slice with printer defaults', async t => {
  const f = await fixture(t);
  const executable = path.join(f.root, 'no-profiles', 'bambu-studio');
  await fs.mkdir(path.dirname(executable));
  await fs.copyFile(f.executable, executable);
  await fs.chmod(executable, 0o755);
  delete process.env.BAMBU_PROFILES_ROOT;
  process.env.BAMBU_SLICER_PROFILE_DIRS = ''; // hermetic: never search the real user profile tree
  const manipulator = new STLManipulator(path.join(f.root, 'no-profiles-out'));
  await assert.rejects(manipulator.sliceSTL(f.stl, 'bambustudio', executable, undefined, undefined, 'Bambu Lab SAFETY 0.4 nozzle'), /profile|preset/i);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

for (const [label, config] of [
  ['missing file', undefined],
  ['malformed JSON', '{not json'],
  ['non-object config', 'null'],
  ['missing printer section', '{}'],
  ['malformed printer section', JSON.stringify({ printer: [] })],
  ['missing selected model', JSON.stringify({ printer: { 'Bambu Lab OTHER': { machine_limits: { cli_safe_acceleration_x: '9000,9000' } } } })],
  ['empty selected model', JSON.stringify({ printer: { 'Bambu Lab SAFETY': {} } })],
  ['array selected model', JSON.stringify({ printer: { 'Bambu Lab SAFETY': [] } })],
  ['empty limits', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { machine_limits: {} } } })],
  ['array limits', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { machine_limits: [] } } })],
  ['null limits', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { machine_limits: null } } })],
  ['invalid limit value', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { machine_limits: { cli_safe_acceleration_x: 'oops' } } } })],
  ['negative limit value', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { machine_limits: { cli_safe_acceleration_x: '-1,6000' } } } })],
  ['non-finite limit value', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { machine_limits: { cli_safe_acceleration_x: 'Infinity,6000' } } } })],
  ['non-limit setting', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { machine_limits: { machine_start_gcode: 'wrong machine' } } } })],
  ['malformed downward check', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { downward_check: [] } } })],
  ['empty downward check', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { downward_check: {} } } })],
  ['malformed downward targets', JSON.stringify({ printer: { 'Bambu Lab SAFETY': { downward_check: { 'Bambu Lab SAFETY 0.4 nozzle': [42] } } } })],
]) {
  test(`CLI configuration ${label} prevents slicer execution`, async t => {
    const f = await fixture(t);
    const configPath = path.join(f.profiles, 'BBL', 'cli_config.json');
    if (config === undefined) await fs.unlink(configPath); else await fs.writeFile(configPath, config);
    await assert.rejects(f.slice(), error => {
      assert.match(error.message, /cli_config\.json/);
      assert.match(error.message, /Bambu Lab SAFETY 0\.4 nozzle/);
      return true;
    });
    await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
  });
}

test('declared machine limits override profile values and report validated config', async t => {
  const f = await fixture(t);
  const machine = JSON.parse(await fs.readFile(f.machine, 'utf8'));
  machine.cli_safe_acceleration_x = '9999,9999';
  await fs.writeFile(f.machine, JSON.stringify(machine));
  const result = await flattenForCli({ machineLeaf: machine.name, processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out') });
  assert.equal(JSON.parse(await fs.readFile(result.machinePath, 'utf8')).cli_safe_acceleration_x, '6000,6000');
  assert.equal(result.meta.cliConfigValidated, true);
  assert.equal(result.meta.cliOverlayApplied, true);
});

test('an explicit missing model cannot borrow limits from its preset name', async t => {
  const f = await fixture(t);
  const machine = JSON.parse(await fs.readFile(f.machine, 'utf8'));
  machine.printer_model = 'Bambu Lab UNKNOWN';
  await fs.writeFile(f.machine, JSON.stringify(machine));
  await assert.rejects(f.slice(), /model "Bambu Lab UNKNOWN".*selected model is absent/);
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

test('custom machines using BBL includes still require the model CLI configuration', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.profiles, 'BBL', 'cli_config.json'));
  await assert.rejects(flattenForCli({ machineLeaf: 'Bambu Lab SAFETY 0.4 nozzle', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out'),
    sourceProfiles: { machine: { name: 'Custom included machine', from: 'User', include: ['SAFETY start'], printer_model: 'Bambu Lab SAFETY' } },
  }), /cli_config\.json/);
});

test('official P1S and H2D config shapes without machine limits remain valid', async t => {
  const f = await fixture(t);
  for (const model of ['Bambu Lab P1S', 'Bambu Lab H2D']) {
    const leaf = `${model} 0.4 nozzle`;
    await f.write('machine', { name: leaf, printer_model: model, nozzle_diameter: ['0.4'], machine_start_gcode: 'model start' });
    // Official BBL configurations declare only downward_check for these models.
    await fs.writeFile(path.join(f.profiles, 'BBL', 'cli_config.json'), JSON.stringify({
      printer: { [model]: { downward_check: { [leaf]: ['Bambu Lab A1 0.4 nozzle'] } } },
    }));
    const result = await flattenForCli({ machineLeaf: leaf, processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out') });
    assert.equal(result.meta.cliConfigValidated, true);
    assert.equal(result.meta.cliOverlayApplied, false);
  }
});

test('standalone custom machine settings do not require a bundled CLI configuration', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.profiles, 'BBL', 'cli_config.json'));
  const result = await flattenForCli({ machineLeaf: 'Standalone custom', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out'),
    sourceProfiles: { machine: { name: 'Standalone custom', from: 'User', nozzle_diameter: ['0.4'], cli_safe_acceleration_x: '5000,5000' } },
  });
  assert.equal(JSON.parse(await fs.readFile(result.machinePath, 'utf8')).cli_safe_acceleration_x, '5000,5000');
  assert.equal(result.meta.cliConfigValidated, false);
  assert.equal(result.meta.cliOverlayApplied, false);
});

test('custom machines inheriting BBL settings still require the model CLI configuration', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.profiles, 'BBL', 'cli_config.json'));
  await assert.rejects(flattenForCli({ machineLeaf: 'Bambu Lab SAFETY 0.4 nozzle', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out'),
    sourceProfiles: { machine: { name: 'Custom inherited machine', from: 'User', inherits: 'Bambu Lab SAFETY 0.4 nozzle' } },
  }), /cli_config\.json/);
});

// BambuStudio CLI crashes when a slice uses a filament slot that has no colour entry.
test('every flattened filament slot carries exactly one colour', async t => {
  const f = await fixture(t);
  const opts = { machineLeaf: 'Bambu Lab SAFETY 0.4 nozzle', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament', 'SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out') };
  const colours = async (result) => Promise.all(result.filamentPaths.map(async p => JSON.parse(await fs.readFile(p, 'utf8')).filament_colour));
  assert.deepEqual(await colours(await flattenForCli(opts)), [['#00AE42'], ['#00AE42']]);
  assert.deepEqual(await colours(await flattenForCli({ ...opts, filamentColours: ['#161616', '#C12E1F'] })), [['#161616'], ['#C12E1F']]);
  const own = await flattenForCli({ ...opts, sourceProfiles: { filaments: [{ name: 'Mine', inherits: 'SAFETY filament', filament_colour: ['#123456'] }, undefined] } });
  assert.deepEqual(await colours(own), [['#123456'], ['#00AE42']]);
  await assert.rejects(flattenForCli({ ...opts, filamentColours: ['#161616'] }), /1 filament colours.*2 filament slots/);
  await assert.rejects(flattenForCli({ ...opts, filamentColours: ['#161616', 'red'] }), /Invalid filament colour "red"/);
});

test('input 3MF project colours reach the flattened filament slots', async t => {
  const f = await fixture(t);
  process.env.BAMBU_CLI_FLATTEN = 'true';
  const zip = new JSZip();
  zip.file('Metadata/project_settings.config', JSON.stringify({ filament_settings_id: ['A', 'B'], filament_type: ['PLA', 'PLA'], filament_colour: ['#FFFFFF', '#9B9EA0'] }));
  const project = path.join(f.root, 'colours.3mf');
  await fs.writeFile(project, await zip.generateAsync({ type: 'nodebuffer' }));
  await f.slice({ loadFilaments: f.filament }, undefined, project);
  const loaded = await f.loaded();
  assert.deepEqual(await Promise.all(loaded.map(async p => JSON.parse(await fs.readFile(p, 'utf8')).filament_colour)), [['#FFFFFF'], ['#9B9EA0']]);
  // An explicit list wins over the project's colours.
  await f.slice({ loadFilaments: f.filament, filamentColours: ['#161616', '#C12E1F'] }, undefined, project);
  assert.deepEqual(await Promise.all((await f.loaded()).map(async p => JSON.parse(await fs.readFile(p, 'utf8')).filament_colour)), [['#161616'], ['#C12E1F']]);
});

test('standalone filament overrides receive positional colours without replacing their settings', async t => {
  const f = await fixture(t);
  const filament = path.join(f.root, 'custom-filament.json');
  const original = { name: 'My PETG', from: 'User', inherits: '', filament_settings_id: ['My PETG'],
    filament_type: ['PETG'], nozzle_temperature: ['250'], filament_colour: ['#123456'] };
  await fs.writeFile(filament, JSON.stringify(original));
  await f.slice({ loadFilaments: filament, filamentColours: ['#161616', '#FFFFFF'] }, undefined, await f.project(2));
  const loaded = await f.loaded();
  assert.equal(loaded.length, 2);
  assert.notEqual(loaded[0], loaded[1]);
  for (const [i, colour] of ['#161616', '#FFFFFF'].entries()) {
    assert.deepEqual(JSON.parse(await fs.readFile(loaded[i], 'utf8')), { ...original, filament_colour: [colour] });
  }
  assert.deepEqual(JSON.parse(await fs.readFile(filament, 'utf8')), original);
});

test('saved project prime tower positions survive slicing unless the process explicitly overrides them', async t => {
  const f = await fixture(t);
  await f.write('machine', { name: 'SAFETY start', nozzle_diameter: ['0.4', '0.4'],
    extruder_printable_area: ['0x0,256x0,256x256,0x256', '20.5x0,256x0,256x256,20.5x256'] });
  const zip = new JSZip();
  zip.file('Metadata/project_settings.config', JSON.stringify({ filament_type: ['PLA'],
    wipe_tower_x: ['160', '170'], wipe_tower_y: ['100', '110'] }));
  const project = path.join(f.root, 'saved-tower.3mf');
  await fs.writeFile(project, await zip.generateAsync({ type: 'nodebuffer' }));
  const readProcess = async () => {
    const args = await f.args();
    return JSON.parse(await fs.readFile(args[args.indexOf('--load-settings') + 1].split(';')[1], 'utf8'));
  };
  await f.slice({}, undefined, project);
  let config = await readProcess();
  assert.deepEqual([config.wipe_tower_x, config.wipe_tower_y], [['160', '170'], ['100', '110']]);
  const processFile = path.join(f.root, 'tower-process.json');
  await fs.writeFile(processFile, JSON.stringify({ name: 'Custom process', inherits: 'SAFETY process',
    wipe_tower_x: ['120'], wipe_tower_y: ['140'] }));
  await f.slice({}, processFile, project);
  config = await readProcess();
  assert.deepEqual([config.wipe_tower_x, config.wipe_tower_y], [['120'], ['140']]);
});

test('standalone process receives tower placement without replacing custom settings', async t => {
  const f = await fixture(t);
  await f.write('machine', { name: 'SAFETY start', nozzle_diameter: ['0.4', '0.4'],
    extruder_printable_area: ['0x0,256x0,256x256,0x256', '20.5x0,256x0,256x256,20.5x256'] });
  const processFile = path.join(f.root, 'standalone-process.json');
  const original = { name: 'My process', from: 'User', inherits: '', layer_height: '0.12', wall_loops: '9' };
  await fs.writeFile(processFile, JSON.stringify(original));
  await f.slice({}, processFile);
  const args = await f.args();
  const config = JSON.parse(await fs.readFile(args[args.indexOf('--load-settings') + 1].split(';')[1], 'utf8'));
  assert.deepEqual(config, { ...original, type: 'process', wipe_tower_x: ['35.5'], wipe_tower_y: ['206'] });
  assert.deepEqual(JSON.parse(await fs.readFile(processFile, 'utf8')), original);
});

test('multi-nozzle machines get a prime tower every nozzle can reach', async t => {
  const f = await fixture(t);
  const opts = { machineLeaf: 'Bambu Lab SAFETY 0.4 nozzle', processLeaf: 'SAFETY process', filamentLeaves: ['SAFETY filament'], profilesRoot: f.profiles, tempDir: path.join(f.root, 'out') };
  const tower = async (result) => {
    const p = JSON.parse(await fs.readFile(result.processPath, 'utf8'));
    return [p.wipe_tower_x, p.wipe_tower_y];
  };
  // Single-nozzle machines keep the CLI default position.
  assert.deepEqual(await tower(await flattenForCli(opts)), [undefined, undefined]);

  // X2D/H2D shape: the second nozzle cannot reach x < 20.5, where the default tower (x=15) sits.
  await f.write('machine', { name: 'SAFETY start', machine_start_gcode: 'M620 S0A ; correct machine', nozzle_diameter: ['0.4', '0.4'],
    extruder_printable_area: ['0x0,256x0,256x256,0x256', '20.5x0,256x0,256x256,20.5x256'] });
  const [x, y] = await tower(await flattenForCli(opts));
  assert.ok(Number(x[0]) >= 20.5 + 15, `tower x ${x} must clear the second nozzle's edge`);
  assert.ok(Number(y[0]) + 35 <= 256 - 15, `tower y ${y} must fit on the bed`);

  // An explicit process position is the user's choice and is preserved.
  const explicit = await flattenForCli({ ...opts, sourceProfiles: { process: { name: 'Custom', inherits: 'SAFETY process', wipe_tower_x: ['165'], wipe_tower_y: ['200'] } } });
  assert.deepEqual(await tower(explicit), [['165'], ['200']]);

  // Nozzle areas that leave no room for the tower stop preparation.
  await f.write('machine', { name: 'SAFETY start', machine_start_gcode: 'M620 S0A ; correct machine',
    extruder_printable_area: ['0x0,60x0,60x256,0x256', '40x0,256x0,256x256,40x256'] });
  await assert.rejects(flattenForCli(opts), /reachable by every nozzle/);
  // Without a prime tower there is nothing to place.
  const noTower = await flattenForCli({ ...opts, sourceProfiles: { process: { name: 'No tower', inherits: 'SAFETY process', enable_prime_tower: '0' } } });
  assert.deepEqual(await tower(noTower), [undefined, undefined]);
});
