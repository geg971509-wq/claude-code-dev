import { Settings } from '../../components/Settings/Settings.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

/**
 * /usage — unified command replacing /cost and /stats (v2.1.118 upstream alignment).
 *
 * Routing:
 *   - /usage and /cost → Settings panel → Usage tab (plan limits + overages)
 *   - /stats           → Settings panel → Stats tab (local activity history)
 *
 * Both /cost and /stats are registered as aliases of this command so that
 * existing muscle-memory still works.
 */
export const call: LocalJSXCommandCall = async (onDone, context, _args, commandName = 'usage') => {
  const defaultTab = commandName === 'stats' ? 'Stats' : 'Usage';
  return <Settings onClose={onDone} context={context} defaultTab={defaultTab} />;
};
