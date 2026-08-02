/**
 * @typedef {{
 *   statusCode: number | null;
 *   allowOriginHeader?: string | null;
 *   recognitionStatusCode?: number | null;
 * }} EngineStatus
 */

/** @param {string} value */
export function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

/** @param {string} output */
export function extractRendererUrl(output) {
  const cleaned = stripAnsi(output);
  const match = cleaned.match(/Local:\s+(https?:\/\/127\.0\.0\.1:\d+)\/?/);

  return match ? match[1] : null;
}

/** @param {number | null} statusCode */
export function shouldReuseRunningEngine(statusCode) {
  return statusCode === 200;
}

/**
 * @param {number | null} statusCode
 * @param {string | null | undefined} allowOriginHeader
 * @param {string} desktopOrigin
 * @param {number | null} recognitionStatusCode
 */
export function shouldReuseRunningEngineForDesktop(statusCode, allowOriginHeader, desktopOrigin, recognitionStatusCode = 200) {
  return shouldReuseRunningEngine(statusCode) && allowOriginHeader === desktopOrigin && recognitionStatusCode === 200;
}

/** @param {number} pid */
export function buildWindowsKillCommand(pid) {
  return `taskkill /PID ${pid} /T /F`;
}

/** @param {string} rendererUrl @param {number} enginePort */
export function buildRendererApiBaseUrl(rendererUrl, enginePort) {
  const url = new URL(rendererUrl);
  url.port = String(enginePort);
  return url.origin;
}

/** @param {number | null | EngineStatus} status */
function readStatusCode(status) {
  if (typeof status === 'object' && status !== null) {
    return status.statusCode;
  }

  return status;
}

/**
 * @param {Array<number | null | EngineStatus>} statuses
 * @param {number} basePort
 * @param {string | null} desktopOrigin
 */
export function chooseEnginePort(statuses, basePort = 8765, desktopOrigin = null) {
  if (desktopOrigin) {
    const compatiblePortIndex = statuses.findIndex(
      (status) =>
        typeof status === 'object' &&
        status !== null &&
        shouldReuseRunningEngineForDesktop(
          status.statusCode,
          status.allowOriginHeader,
          desktopOrigin,
          status.recognitionStatusCode ?? null
        )
    );
    if (compatiblePortIndex >= 0) {
      return basePort + compatiblePortIndex;
    }

    const availablePortIndex = statuses.findIndex((status) => readStatusCode(status) === null);
    if (availablePortIndex >= 0) {
      return basePort + availablePortIndex;
    }

    return basePort + statuses.length;
  }

  const healthyPortIndex = statuses.findIndex((status) => shouldReuseRunningEngine(readStatusCode(status)));
  if (healthyPortIndex >= 0) {
    return basePort + healthyPortIndex;
  }

  const availablePortIndex = statuses.findIndex((status) => readStatusCode(status) === null);
  if (availablePortIndex >= 0) {
    return basePort + availablePortIndex;
  }

  return basePort + statuses.length;
}
