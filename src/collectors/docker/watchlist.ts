import type { Config } from '../../config/types.js';

/**
 * Returns true if Opsling should monitor (collect stats + alert on) this
 * container. The model is deny-list only: everything is watched by default
 * unless explicitly listed in IGNORE_CONTAINERS.
 */
export const isContainerWatched = (name: string, config: Config): boolean =>
  !config.ignoreContainers.includes(name);
