import { handleScfEvent, loadScfEnv, type ScfEvent } from "../../../tools/maintenance-scheduler/src/scf";
export const main_handler = (event: ScfEvent): Promise<unknown> => handleScfEvent(event, loadScfEnv());
