export { TRENCH_SIZES, trenchKey, findTrenchConflict } from './trench'
export type { Trench, TrenchSize } from './trench'
export { UNIT_TYPES, INCLUSIONS, stratumThickness, isDepthInverted, isCodeDuplicated } from './stratum'
export type { Stratum, UnitType, Inclusion } from './stratum'
export {
  ARTIFACT_CATEGORIES,
  COMPLETENESS,
  ARTIFACT_LEDGER_STATUS,
  ARTIFACT_STATUS_LABEL,
  SUSPEND_RESOLUTIONS
} from './artifact'
export type {
  Artifact,
  ArtifactCategory,
  Completeness,
  ArtifactLedgerStatus,
  SuspendResolution
} from './artifact'
export { RELATION_TYPES, RELATION_BASES } from './relation'
export type { Relation, RelationType, RelationBasis } from './relation'
export {
  BasePointError,
  COORD_EPSILON,
  RECONCILE_TOLERANCE,
  parseBasePointText,
  formatBasePoint,
  currentBasePoint,
  basePointByVersion,
  versionsOfTrench,
  recomputeReading,
  absoluteCoord,
  isCoordMatch
} from './basePoint'
export type { BasePointVersion } from './basePoint'
