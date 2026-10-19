// Registre d'actions et session du copilot IA (ADR 0018, spécification §5 et §6.3).

export {
  COPILOT_ACTIONS,
  COPILOT_ACTION_IDS,
  COPILOT_ACTION_NATURES,
  COPILOT_DAY_PARTS,
  COPILOT_DOMAINS,
  COPILOT_GUIDE_ROUTES,
  COPILOT_REQUIREMENTS,
  isCopilotActionId,
  isCopilotRequirement,
} from './actions';
export type {
  CopilotActionDefinition,
  CopilotActionId,
  CopilotActionNature,
  CopilotActionParams,
  CopilotDayPart,
  CopilotDomain,
  CopilotGuideRoute,
  CopilotRequirement,
} from './actions';
export {
  COPILOT_SURFACES,
  copilotSessionSchema,
  exposedDomains,
  permittedActions,
  permittedGuideRoutes,
  meetsRequirement,
  surfaceOf,
} from './session';
export type { CopilotSession, CopilotSurface } from './session';
