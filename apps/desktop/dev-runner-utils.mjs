export function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

export function extractRendererUrl(output) {
  const cleaned = stripAnsi(output);
  const match = cleaned.match(/Local:\s+(https?:\/\/127\.0\.0\.1:\d+)\/?/);

  return match ? match[1] : null;
}

export function shouldReuseRunningEngine(statusCode) {
  return statusCode === 200;
}

export function shouldReuseRunningEngineForDesktop(statusCode, allowOriginHeader, desktopOrigin, recognitionStatusCode = 200) {
  return shouldReuseRunningEngine(statusCode) && allowOriginHeader === desktopOrigin && recognitionStatusCode === 200;
}

export function buildWindowsKillCommand(pid) {
  return `taskkill /PID ${pid} /T /F`;
}

export function buildRendererApiBaseUrl(rendererUrl, enginePort) {
  const url = new URL(rendererUrl);
  url.port = String(enginePort);
  return url.origin;
}

function readStatusCode(status) {
  if (typeof status === 'object' && status !== null) {
    return status.statusCode;
  }

  return status;
}

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
