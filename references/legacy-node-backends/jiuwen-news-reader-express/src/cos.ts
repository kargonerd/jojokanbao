import COS from 'cos-nodejs-sdk-v5'
import { v4 as uuidv4 } from 'uuid'

// 初始化 COS 客户端
const cos = new COS({
  SecretId: process.env.COS_SECRET_ID || '',
  SecretKey: process.env.COS_SECRET_KEY || '',
})

// COS 配置
const COS_CONFIG = {
  Bucket: process.env.COS_BUCKET || '',
  Region: process.env.COS_REGION || 'ap-beijing',
}

// 上传图片到 COS
export async function uploadImage(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    // 生成唯一文件名
    const ext = fileName.split('.').pop() || 'jpg'
    const key = `avatars/${uuidv4()}.${ext}`
    
    cos.putObject(
      {
        Bucket: COS_CONFIG.Bucket,
        Region: COS_CONFIG.Region,
        Key: key,
        Body: fileBuffer,
        ContentType: mimeType,
        // 设置公共读权限
        ACL: 'public-read',
      },
      (err, data) => {
        if (err) {
          console.error('[COS] 上传失败:', err)
          reject(new Error('上传图片失败'))
        } else {
          console.log('[COS] 上传成功:', data)
          // 返回图片访问 URL
          const url = `https://${COS_CONFIG.Bucket}.cos.${COS_CONFIG.Region}.myqcloud.com/${key}`
          resolve(url)
        }
      }
    )
  })
}

// 从 COS 删除图片
export async function deleteImage(imageUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 从 URL 中提取 Key
    const url = new URL(imageUrl)
    const key = url.pathname.substring(1) // 去掉开头的 /
    
    cos.deleteObject(
      {
        Bucket: COS_CONFIG.Bucket,
        Region: COS_CONFIG.Region,
        Key: key,
      },
      (err) => {
        if (err) {
          console.error('[COS] 删除失败:', err)
          reject(new Error('删除图片失败'))
        } else {
          console.log('[COS] 删除成功:', key)
          resolve()
        }
      }
    )
  })
}

export { COS_CONFIG }
