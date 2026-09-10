"""Publish the reviewed 2026-07-19..2026-09-10 RMRB backfill from cloud storage."""
import base64,concurrent.futures,copy,gzip,hashlib,json,os,subprocess,sys
from pathlib import Path
import boto3,numpy as np
from botocore.config import Config
from botocore.exceptions import ClientError
from boto3.s3.transfer import TransferConfig
from huggingface_hub import HfApi,CommitOperationAdd
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'content-pipeline'))
import jojo_format as jox
plan=json.loads(Path(__file__).with_name('backfill-plan-20260910.json').read_text())
work=Path('.rmrb-cloud-backfill');work.mkdir(exist_ok=True)
bucket=os.environ.get('B2_BUCKET') or 'jojo-newspaper'
assert bucket=='jojo-newspaper'
s3=boto3.client('s3',endpoint_url='https://s3.us-west-004.backblazeb2.com',region_name='us-west-004',
    aws_access_key_id=os.environ['B2_KEY_ID'],aws_secret_access_key=os.environ['B2_APPLICATION_KEY'],
    config=Config(connect_timeout=15,read_timeout=120,retries={'max_attempts':5},max_pool_connections=32))
hf=HfApi(token=os.environ['HF_TOKEN']);repo='luoxiaozhuang/marxism-dataset'
assert hf.repo_info(repo,repo_type='dataset',expand=['sha']).sha==plan['parent'],'Canonical changed; refresh the plan'

def read_remote(key):
    try:
        with s3.get_object(Bucket=bucket,Key=key)['Body'] as body:return body.read()
    except ClientError as e:
        if e.response['Error']['Code'] in ('404','NoSuchKey','NotFound'):return None
        raise
def unchanged():
    def check(pair):
        key,encoded=pair
        assert read_remote(key)==(base64.b64decode(encoded) if encoded else None),'Delivery changed: '+key
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:list(pool.map(check,plan['baselines'].items()))
unchanged()
print('Pinned Canonical and Delivery revisions verified',flush=True)
original=jox._transform_jox
def fast(raw,key):
    src=np.frombuffer(raw,dtype=np.uint8);out=np.empty(len(src),dtype=np.uint8)
    for start in range(0,len(src),4194304):
        end=min(len(src),start+4194304);v=np.arange(start,end,dtype=np.uint32)
        v+=np.uint32(0x9e3779b9);v^=np.uint32(jox._fnv1a(key));v^=np.uint32(0x4a4f5831)
        v^=v>>np.uint32(16);v*=np.uint32(0x7feb352d);v^=v>>np.uint32(15);v*=np.uint32(0x846ca68b);v^=v>>np.uint32(16)
        out[start:end]=src[start:end]^v.astype(np.uint8)
    return out.tobytes()
assert fast(bytes(range(256))*32,'test')==original(bytes(range(256))*32,'test')
jox._transform_jox=fast
def write_json(key,value):
    target=work/'canonical'/key;target.parent.mkdir(parents=True,exist_ok=True)
    raw=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode()
    target.write_bytes(gzip.compress(raw,mtime=0) if key.endswith('.gz') else raw);return target

def prepare(row):
    day=row['date'];folder=work/day;folder.mkdir(exist_ok=True)
    protected=folder/'protected.pdf';decoded=folder/'decoded.pdf';pdf=folder/'linearized.pdf'
    s3.download_file(bucket,'RMRB/2026/'+day.replace('-','')+'.pdf',str(protected),Config=TransferConfig(max_concurrency=2))
    assert protected.stat().st_size==row['sourceSize']
    subprocess.run(['node','tools/archive-pdf/protect.mjs','decode',str(protected),str(decoded)],check=True,capture_output=True)
    with decoded.open('rb') as stream:assert hashlib.file_digest(stream,'sha256').hexdigest()==row['sourceSha256']
    result=subprocess.run(['qpdf','--linearize',str(decoded),str(pdf)],capture_output=True,text=True)
    assert result.returncode in (0,3),result.stderr
    result=subprocess.run(['qpdf','--check-linearization',str(pdf)],capture_output=True,text=True)
    assert 'no linearization errors' in result.stdout+result.stderr
    with pdf.open('rb') as stream:sha=hashlib.file_digest(stream,'sha256').hexdigest()
    size=pdf.stat().st_size;manifest=copy.deepcopy(row['manifestValue']);item=copy.deepcopy(row['itemValue'])
    object_name='assets/'+sha+'.pdf.jox';key=row['manifest'].removesuffix('manifest.jox')+object_name
    for value in (manifest,item):
        asset=next(a for a in value['assets'] if a.get('role')=='issue-pdf')
        asset.update(id='asset:issue-pdf-'+sha[:16],sha256=sha,size=size)
        if value is manifest:asset['object']=object_name
    canonical={row['item']:write_json(row['item'],item),row['pdf']:pdf}
    media=work/'delivery'/key;jox._write_jox_file(media,key,pdf)
    metadata=work/'delivery'/row['manifest'];jox._write_jox(metadata,row['manifest'],manifest)
    proofs={}
    with pdf.open('rb') as stream:
        for offset,length in [(0,64),(65536,128)]:stream.seek(offset);proofs[str(offset)]=stream.read(length).hex()
    report={'date':day,'asset':key,'manifest':row['manifest'],'index':plan['index'],'published':True,'sha256':sha,'size':size,'rangeProof':proofs}
    print('PREPARED '+day,flush=True)
    return {'canonical':canonical,'media':media,'metadata':metadata,'report':report}

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:prepared=list(pool.map(prepare,plan['issues']))
files={plan['dataset']:write_json(plan['dataset'],plan['datasetValue'])}
for row in prepared:files.update(row['canonical'])
unchanged()
print('Uploading Canonical batch: '+str(len(files))+' files',flush=True)
commit=hf.create_commit(repo,repo_type='dataset',parent_commit=plan['parent'],num_threads=8,
    commit_message='Backfill RMRB PDFs from 2026-07-19 through 2026-09-10',
    operations=[CommitOperationAdd(path_in_repo=k,path_or_fileobj=str(p)) for k,p in files.items()])
(work/'canonical-commit.json').write_text(json.dumps({'commit':commit.oid,'parent':plan['parent']}))
print('CANONICAL COMMIT '+commit.oid,flush=True)
def upload(row):
    path=row['media'];key=row['report']['asset'];sha=hashlib.sha256(path.read_bytes()).hexdigest()
    old=read_remote(key)
    if old is not None:assert hashlib.sha256(old).hexdigest()==sha,'Immutable asset conflict'
    else:s3.upload_file(str(path),bucket,key,ExtraArgs={'ContentType':'application/octet-stream','CacheControl':'public, max-age=31536000, immutable','Metadata':{'encoded-sha256':sha}},Config=TransferConfig(max_concurrency=2))
    assert s3.head_object(Bucket=bucket,Key=key)['ContentLength']==path.stat().st_size
    print('ASSET '+row['report']['date'],flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(upload,prepared))
unchanged()
def metadata(row):
    raw=row['metadata'].read_bytes();key=row['report']['manifest']
    s3.put_object(Bucket=bucket,Key=key,Body=raw,ContentType='application/octet-stream',CacheControl='public, max-age=0, must-revalidate')
    assert read_remote(key)==raw
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(metadata,prepared))
assert read_remote(plan['index'])==base64.b64decode(plan['baselines'][plan['index']])
target=work/'index.jox';jox._write_jox(target,plan['index'],plan['indexValue']);raw=target.read_bytes()
s3.put_object(Bucket=bucket,Key=plan['index'],Body=raw,ContentType='application/octet-stream',CacheControl='public, max-age=0, must-revalidate')
assert read_remote(plan['index'])==raw
reports=plan['completed']+[r['report'] for r in prepared]
assert len(reports)==54
(work/'publication.json').write_text(json.dumps(reports,indent=2)+'\n')
print('COMPLETE: all 54 issues published to Canonical and Delivery',flush=True)
