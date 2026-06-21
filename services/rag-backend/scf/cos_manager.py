"""Tencent Cloud COS manager for file storage."""

import os
import json
import hashlib
import time
from typing import Optional, BinaryIO, Dict, Any
from datetime import datetime, timedelta

# Get project root directory for mock storage
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MOCK_COS_DIR = os.path.join(PROJECT_ROOT, 'mock_cos')

# Try to import qcloud_cos
try:
    from qcloud_cos import CosConfig, CosS3Client
    COS_SDK_AVAILABLE = True
except ImportError:
    COS_SDK_AVAILABLE = False
    print("[COS] qcloud_cos SDK not available, using mock mode")


class COSManager:
    """Manager for Tencent Cloud COS operations."""
    
    def __init__(self, bucket: str = None, region: str = None, 
                 secret_id: str = None, secret_key: str = None):
        """Initialize COS manager.
        
        Args:
            bucket: COS bucket name
            region: COS region (e.g., ap-beijing)
            secret_id: Tencent Cloud SecretId
            secret_key: Tencent Cloud SecretKey
        """
        self.bucket = bucket or os.environ.get('COS_BUCKET', 'document-1314955862')
        self.region = region or os.environ.get('COS_REGION', 'ap-beijing')
        self.secret_id = secret_id or os.environ.get('TENCENT_SECRET_ID')
        self.secret_key = secret_key or os.environ.get('TENCENT_SECRET_KEY')
        self.public_base_url = (
            os.environ.get('CDN_BASE_URL')
            or os.environ.get('COS_PUBLIC_BASE_URL')
            or 'https://document.jojokanbao.cn'
        ).rstrip('/')
        
        self.client = None
        self._init_client()
    
    def _init_client(self):
        """Initialize COS client."""
        if not COS_SDK_AVAILABLE:
            return
        
        if not self.secret_id or not self.secret_key:
            print("[COS] Missing credentials, using mock mode")
            return
        
        try:
            config = CosConfig(
                Region=self.region,
                SecretId=self.secret_id,
                SecretKey=self.secret_key,
                Token=None,
                Scheme='https'
            )
            self.client = CosS3Client(config)
            print(f"[COS] Initialized for bucket: {self.bucket}, region: {self.region}")
        except Exception as e:
            print(f"[COS] Failed to initialize client: {e}")
            self.client = None

    def refresh_from_env(self):
        """Reload config from env and retry client initialization."""
        self.bucket = os.environ.get('COS_BUCKET', self.bucket or 'document-1314955862')
        self.region = os.environ.get('COS_REGION', self.region or 'ap-beijing')
        self.secret_id = os.environ.get('TENCENT_SECRET_ID', self.secret_id)
        self.secret_key = os.environ.get('TENCENT_SECRET_KEY', self.secret_key)
        self.public_base_url = (
            os.environ.get('CDN_BASE_URL')
            or os.environ.get('COS_PUBLIC_BASE_URL')
            or self.public_base_url
            or 'https://document.jojokanbao.cn'
        ).rstrip('/')
        self.client = None
        self._init_client()
    
    def is_available(self) -> bool:
        """Check if COS is available."""
        return COS_SDK_AVAILABLE and self.client is not None
    
    def upload_file(self, key: str, file_obj: BinaryIO, 
                    content_type: str = None) -> Optional[str]:
        """Upload file to COS.
        
        Args:
            key: Object key (path in bucket)
            file_obj: File-like object to upload
            content_type: MIME type
            
        Returns:
            Public URL of uploaded file, or None if failed
        """
        if not self.is_available():
            # Mock mode: save to local file for development
            return self._mock_upload(key, file_obj)
        
        try:
            # Reset file pointer
            file_obj.seek(0)
            
            # Upload
            response = self.client.put_object(
                Bucket=self.bucket,
                Body=file_obj,
                Key=key,
                ContentType=content_type or 'application/octet-stream'
            )
            
            # Generate URL
            url = self.build_public_url(key)
            print(f"[COS] Uploaded: {key} -> {url}")
            return url
            
        except Exception as e:
            print(f"[COS] Upload failed: {e}")
            return None
    
    def upload_json(self, key: str, data: Dict[str, Any]) -> Optional[str]:
        """Upload JSON data to COS.
        
        Args:
            key: Object key
            data: Dictionary to serialize as JSON
            
        Returns:
            Public URL of uploaded file
        """
        import io
        json_str = json.dumps(data, ensure_ascii=False, indent=2)
        file_obj = io.BytesIO(json_str.encode('utf-8'))
        return self.upload_file(key, file_obj, 'application/json')
    
    def download_json(self, key: str) -> Optional[Dict[str, Any]]:
        """Download and parse JSON from COS.
        
        Args:
            key: Object key
            
        Returns:
            Parsed JSON data, or None if not found
        """
        if not self.is_available():
            return self._mock_download_json(key)
        
        try:
            response = self.client.get_object(
                Bucket=self.bucket,
                Key=key
            )
            data = json.loads(response['Body'].read().decode('utf-8'))
            return data
            
        except Exception as e:
            if 'NoSuchKey' in str(e):
                return None
            print(f"[COS] Download failed: {e}")
            return None
    
    def delete_file(self, key: str) -> bool:
        """Delete file from COS.
        
        Args:
            key: Object key
            
        Returns:
            True if successful
        """
        if not self.is_available():
            return self._mock_delete(key)
        
        try:
            self.client.delete_object(
                Bucket=self.bucket,
                Key=key
            )
            print(f"[COS] Deleted: {key}")
            return True
            
        except Exception as e:
            print(f"[COS] Delete failed: {e}")
            return False
    
    def list_files(self, prefix: str = '') -> list:
        """List files in bucket with given prefix.
        
        Args:
            prefix: Key prefix to filter
            
        Returns:
            List of file keys
        """
        if not self.is_available():
            return self._mock_list(prefix)
        
        try:
            response = self.client.list_objects(
                Bucket=self.bucket,
                Prefix=prefix
            )
            
            contents = response.get('Contents', [])
            return [obj['Key'] for obj in contents]
            
        except Exception as e:
            print(f"[COS] List failed: {e}")
            return []
    
    def generate_presigned_url(self, key: str, expires: int = 3600) -> Optional[str]:
        """Generate presigned URL for temporary access.
        
        Args:
            key: Object key
            expires: Expiration time in seconds
            
        Returns:
            Presigned URL
        """
        if not self.is_available():
            return f"https://mock-url/{key}"
        
        try:
            url = self.client.get_presigned_url(
                Method='GET',
                Bucket=self.bucket,
                Key=key,
                Expired=expires
            )
            return url
            
        except Exception as e:
            print(f"[COS] Generate URL failed: {e}")
            return None
    
    # Mock methods for local development
    def _mock_upload(self, key: str, file_obj: BinaryIO) -> str:
        """Mock upload for local development."""
        # Save to local directory
        os.makedirs(MOCK_COS_DIR, exist_ok=True)
        
        filepath = os.path.join(MOCK_COS_DIR, key.replace('/', '_'))
        file_obj.seek(0)
        with open(filepath, 'wb') as f:
            f.write(file_obj.read())
        
        print(f"[COS Mock] Saved to: {filepath}")
        return f"file://{filepath}"

    def build_public_url(self, key: str) -> str:
        """Build a public URL for a COS object key."""
        if self.public_base_url:
            return f"{self.public_base_url}/{key.lstrip('/')}"
        return f"https://{self.bucket}.cos.{self.region}.myqcloud.com/{key}"
    
    def _mock_download_json(self, key: str) -> Optional[Dict]:
        """Mock download for local development."""
        filepath = os.path.join(MOCK_COS_DIR, key.replace('/', '_'))
        
        if not os.path.exists(filepath):
            return None
        
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def _mock_delete(self, key: str) -> bool:
        """Mock delete for local development."""
        filepath = os.path.join(MOCK_COS_DIR, key.replace('/', '_'))
        
        if os.path.exists(filepath):
            os.remove(filepath)
            print(f"[COS Mock] Deleted: {filepath}")
            return True
        return False
    
    def _mock_list(self, prefix: str) -> list:
        """Mock list for local development."""
        if not os.path.exists(MOCK_COS_DIR):
            return []
        
        files = []
        for f in os.listdir(MOCK_COS_DIR):
            if f.startswith(prefix.replace('/', '_')):
                files.append(f.replace('_', '/'))
        return files


# Singleton instance
_cos_manager = None

def get_cos_manager() -> COSManager:
    """Get singleton COS manager instance."""
    global _cos_manager
    if _cos_manager is None:
        _cos_manager = COSManager()
    elif not _cos_manager.is_available() and os.environ.get('TENCENT_SECRET_ID') and os.environ.get('TENCENT_SECRET_KEY'):
        _cos_manager.refresh_from_env()
    return _cos_manager


def generate_unique_id(prefix: str = '') -> str:
    """Generate unique ID."""
    timestamp = int(time.time() * 1000)
    random_str = hashlib.md5(os.urandom(16)).hexdigest()[:8]
    return f"{prefix}{timestamp}_{random_str}"


# Helper functions for JOJO library

def get_library_key(library_id: str) -> str:
    """Get COS key for library cover."""
    return f"libraries/{library_id}/cover.jpg"


def get_book_key(book_id: str, filename: str) -> str:
    """Get COS key for book file."""
    ext = os.path.splitext(filename)[1] or '.md'
    return f"books/{book_id}/content{ext}"


def get_book_cover_key(book_id: str) -> str:
    """Get COS key for book cover."""
    return f"books/{book_id}/cover.jpg"


def get_highlights_key(book_id: str) -> str:
    """Get COS key for highlights data."""
    return f"highlights/{book_id}.json"


def get_notebook_cover_key(notebook_id: str) -> str:
    """Get COS key for notebook/library cover image."""
    return f"catalog/notebooks/{notebook_id}/cover.jpg"


def get_source_cover_key(notebook_id: str, source_id: str) -> str:
    """Get COS key for source cover image."""
    return f"catalog/notebooks/{notebook_id}/sources/{source_id}/cover.jpg"


def get_source_markdown_key(notebook_id: str, source_id: str) -> str:
    """Get COS key for normalized markdown document."""
    return f"catalog/notebooks/{notebook_id}/sources/{source_id}/document.md"


def get_source_pdf_key(notebook_id: str, source_id: str, filename: str = 'source.pdf') -> str:
    """Get COS key for original uploaded PDF."""
    ext = os.path.splitext(filename)[1] or '.pdf'
    return f"catalog/notebooks/{notebook_id}/sources/{source_id}/original{ext}"


def get_source_asset_key(notebook_id: str, source_id: str, filename: str) -> str:
    """Get COS key for source asset files referenced by markdown."""
    safe_name = os.path.basename(filename) or generate_unique_id('asset_')
    return f"catalog/notebooks/{notebook_id}/sources/{source_id}/assets/{safe_name}"
