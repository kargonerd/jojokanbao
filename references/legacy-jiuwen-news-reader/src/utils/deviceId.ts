// 生成或获取设备ID
export function getOrCreateDeviceId(): string {
  const STORAGE_KEY = 'news_reader_device_id'
  
  let deviceId = localStorage.getItem(STORAGE_KEY)
  
  if (!deviceId) {
    // 生成随机设备ID
    deviceId = 'device_' + Math.random().toString(36).substring(2, 15) + 
               Math.random().toString(36).substring(2, 15)
    localStorage.setItem(STORAGE_KEY, deviceId)
  }
  
  return deviceId
}

// 获取设备信息
export function getDeviceInfo() {
  return {
    deviceId: getOrCreateDeviceId(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
  }
}
