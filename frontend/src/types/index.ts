export { TRENCH_SIZES, trenchKey, findTrenchConflict } from './trench'
export type { Trench, TrenchSize } from './trench'
export { UNIT_TYPES, INCLUSIONS, stratumThickness, isDepthInverted, isCodeDuplicated } from './stratum'
export type { Stratum, UnitType, Inclusion } from './stratum'
export {
  ARTIFACT_CATEGORIES,
  COMPLETENESS,
  ARTIFACT_STATUSES,
  ARTIFACT_STATUS_LABEL,
  toGlobalCoordinate,
  isCoordinateMatch,
  rebaseReading
} from './artifact'
export type { Artifact, ArtifactCategory, Completeness, ArtifactStatus, RecalcIssue } from './artifact'
export { parseBasePointNote, isBasePointComplete, basePointLabel } from './basepoint'
export type { BasePoint } from './basepoint'
export { RELATION_TYPES, RELATION_BASES } from './relation'
export type { Relation, RelationType, RelationBasis } from './relation'
