import { id } from "../internal";
import type {
  AoiDefinition,
  InstructionNode,
  PlcConfiguration,
  PlcNetwork,
  PlcProgramUnit,
  PlcRoutine,
  PlcRung,
  PouDefinition,
  ProgramSource,
} from "../types";

export function normalizeSourceStructureIds(source: ProgramSource): void {
  source.id ??= id("source");
  for (const task of source.tasks ?? []) task.id ??= id("task");
  for (const program of source.programs ?? []) normalizeProgramUnitIds(program);
  for (const pou of source.pous ?? []) normalizePouIds(pou);
  for (const aoi of source.aois ?? []) normalizeAoiIds(aoi);
}

export function normalizeConfigurationIds(configuration: PlcConfiguration): void {
  configuration.id ??= id("configuration");
  for (const resource of configuration.resources) {
    resource.id ??= id("resource");
    for (const task of resource.tasks) task.id ??= id("task");
    for (const instance of resource.programs) instance.id ??= id("program-instance");
  }
}

function normalizeProgramUnitIds(program: PlcProgramUnit): void {
  program.id ??= id("program");
  for (const routine of program.routines ?? []) normalizeRoutineIds(routine);
}

function normalizePouIds(pou: PouDefinition): void {
  pou.id ??= id("pou");
  for (const routine of pou.body.routines ?? []) normalizeRoutineIds(routine);
  for (const network of pou.body.networks ?? []) normalizeNetworkIds(network);
}

function normalizeAoiIds(aoi: AoiDefinition): void {
  aoi.id ??= id("aoi");
  for (const routine of aoi.routines) normalizeRoutineIds(routine);
}

export function normalizeRoutineIds(routine: PlcRoutine): void {
  routine.id ??= id("routine");
  for (const rung of routine.rungs ?? []) normalizeRungIds(rung);
  for (const network of routine.networks ?? []) normalizeNetworkIds(network);
}

function normalizeNetworkIds(network: PlcNetwork): void {
  network.id ??= id("network");
  for (const instruction of network.instructions ?? []) normalizeInstructionIds(instruction);
  for (const rung of network.rungs ?? []) normalizeRungIds(rung);
}

function normalizeRungIds(rung: PlcRung): void {
  rung.id ??= id("rung");
  for (const instruction of rung.instructions) normalizeInstructionIds(instruction);
}

function normalizeInstructionIds(instruction: InstructionNode): void {
  instruction.id ??= id(instruction.opcode || "instruction");
  for (const child of instruction.children ?? []) normalizeInstructionIds(child);
}
