// Public argument-routing test only: every network operation is forbidden and
// the physical dispatch boundary is replaced with a receipt of its arguments.
import './inspection-no-network.mjs';
import {BambuImplementation} from '../../dist/printers/bambu.js';
import {STLManipulator} from '../../dist/stl/stl-manipulator.js';
let sliced;
STLManipulator.prototype.sliceSTL = async function (...args) {
  sliced = args[7];
  return args[0];
};
BambuImplementation.prototype.print3mf = async function (_host, _serial, _token, options) {
  return {mock: true, plateIndex: options.plateIndex, sliced};
};
