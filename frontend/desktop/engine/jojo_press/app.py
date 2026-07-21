from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api.export import router as export_router
from .api.projects import router as projects_router
from .api.proofread import router as proofread_router
from .api.quality import router as quality_router
from .api.tasks import router as tasks_router
from .config import Settings

# 加载 .env 文件中的环境变量
env_path = Path(__file__).resolve().parents[1] / '.env'
load_dotenv(env_path)

settings = Settings()
app = FastAPI(title=settings.app_name)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r'http://(127\.0\.0\.1|localhost):\d+',
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# 挂载静态文件目录用于 PDF 访问
static_path = Path(__file__).resolve().parents[1] / 'static'
static_path.mkdir(exist_ok=True)
app.mount('/static', StaticFiles(directory=str(static_path)), name='static')

for router in (projects_router, tasks_router, proofread_router, quality_router, export_router):
    app.include_router(router)


@app.get('/health')
def health() -> dict[str, str]:
    return {'status': 'ok'}
