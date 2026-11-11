import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Course, CourseDocument, Job, ProviderSettings } from '../src/types.ts';
import { dataDir, mediaDir, initializeStorage, listCourses, getCourse, saveCourse, removeCourse, getSettings, saveSettings, publicSettings } from './storage.ts';
import { parsePptx } from './documents.ts';
import { parseTranscript, normalizeKeywords, retimeEstimated, extractHighlights, localChat, exportCourse, selectCues } from './processing.ts';
import { testProvider, chatWithCourse, runCourseJob, isProviderConfigured, ProviderError, listProviderModels } from './ai.ts';

import {localAsrStatus,runLocalRecognition} from './local-asr.ts';
import {getWorkflow,startWorkflow,reviewWorkflowItem,isWorkflowActive,removeWorkflow,startAuditRecheck} from './workflow.ts';
import {localModelStatus,ensureLocalModelServer,effectiveLocalSettings} from './local-model.ts';

const execFileAsync=promisify(execFile);
const mediaExtensions=new Set(['.mp3','.wav','.m4a','.ogg','.mp4','.webm','.mov']);
const docExtensions=new Set(['.md','.txt','.srt','.vtt','.pdf','.pptx']);
const jobs=new Map<string,Job>();
const activeJobs=new Set<string>();
const error=(status:number,message:string)=>Object.assign(new Error(message),{status});
await initializeStorage();
const upload=multer({storage:multer.diskStorage({destination:mediaDir,filename:(_req,file,cb)=>cb(null,`${randomUUID()}${path.extname(file.originalname).toLowerCase()}`)}),limits:{fileSize:1024*1024*1024,files:8,fieldSize:10*1024*1024},fileFilter:(_req,file,cb)=>{
  const extension=path.extname(file.originalname).toLowerCase();
  if (!mediaExtensions.has(extension)&&!docExtensions.has(extension)) return cb(error(415,'不支持的文件格式。请使用音视频、MD、TXT、SRT、VTT、PDF 或 PPTX。'));
  cb(null,true);
}}).array('files',8);
const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'12mb'}));
app.use((req,_res,next)=>{req.body ??= {};next();});
app.use('/media',express.static(mediaDir,{dotfiles:'deny',setHeaders(res){res.setHeader('X-Content-Type-Options','nosniff');}}));
const route=(handler:(req:express.Request,res:express.Response)=>Promise<unknown>)=>(req:express.Request,res:express.Response,next:express.NextFunction)=>{handler(req,res).catch(next);};
function uploaded(req:express.Request){return (req.files as Express.Multer.File[])||[];}
function uploadRequest(req:express.Request,res:express.Response):Promise<void>{return new Promise((resolve,reject)=>upload(req,res,err=>err?reject(err):resolve()));}
async function cleanup(files:Express.Multer.File[]){await Promise.all(files.map(file=>fs.rm(file.path,{force:true})));}
function originalName(value:string){const name=Buffer.from(value,'latin1').toString('utf8');return !name.includes('\uFFFD')?name:value;}
async function documentText(file:Express.Multer.File){
  if(file.size>10*1024*1024)throw error(413,'文字稿或演示文稿请控制在 10 MiB 内，音视频最大支持 1 GiB。');
  const ext=path.extname(file.originalname).toLowerCase();
  if(ext==='.pdf'){
    const pdf=(await import('pdf-parse/lib/pdf-parse.js')).default;
    try {const result=await pdf(await fs.readFile(file.path));if(!result.text.trim())throw error(422,'PDF 没有可提取的文字，扫描件请先 OCR 或导出文字稿。');return result.text;}
    catch(e){if((e as {status?:number}).status)throw e;throw error(422,'PDF 解析失败，请导出为 TXT 或 Markdown 后重试。');}
  }
  if(ext==='.pptx')return parsePptx(await fs.readFile(file.path));
  return fs.readFile(file.path,'utf8');
}
async function addFiles(course:Course,files:Express.Multer.File[],transcript?:string){
  const media=files.filter(f=>mediaExtensions.has(path.extname(f.originalname).toLowerCase()));
  if(media.length>1)throw error(400,'每门课程只能有一个主音视频，请分课程导入。');
  const oldMedia=course.media?.url;
  if(media[0]){
    const file=media[0],ext=path.extname(file.originalname).toLowerCase();
    const types:Record<string,string>={'.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.ogg':'audio/ogg','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'};
    course.media={url:`/media/${file.filename}`,name:originalName(file.originalname),type:types[ext]};
    try {const {stdout}=await execFileAsync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file.path],{timeout:20000,maxBuffer:10000});const duration=Number(stdout.trim());if(Number.isFinite(duration)&&duration>0)course.media.duration=duration;}catch{/* Browser can supply metadata if ffprobe is unavailable. */}
  }
  const documents: {doc:CourseDocument;ext:string}[]=[];
  for(const file of files.filter(f=>docExtensions.has(path.extname(f.originalname).toLowerCase()))){
    const text=await documentText(file);
    if(!text.trim())throw error(422,`文件 ${originalName(file.originalname)} 没有文字内容。`);
    documents.push({doc:{id:randomUUID(),name:originalName(file.originalname),type:path.extname(file.originalname).slice(1).toLowerCase(),text},ext:path.extname(file.originalname).toLowerCase()});
  }
  if(transcript?.trim())documents.push({doc:{id:randomUUID(),name:'粘贴文字稿.md',type:'md',text:transcript},ext:'.md'});
  course.documents.push(...documents.map(d=>d.doc));
  const primary=documents.find(d=>d.ext==='.srt'||d.ext==='.vtt')||documents.find(d=>d.ext==='.md'||d.ext==='.txt')||(!course.cues.length?documents[0]:undefined);
  if(primary){const parsed=parseTranscript(primary.doc.text,primary.doc.name,course.media?.duration);Object.assign(course,parsed);}
  else if(media[0]&&course.media?.duration)retimeEstimated(course,course.media.duration);
  // Remove uploaded source files after extraction; original text lives in course JSON.
  await cleanup(files.filter(f=>docExtensions.has(path.extname(f.originalname).toLowerCase())));
  return oldMedia&&media[0]?path.join(mediaDir,path.basename(oldMedia)):undefined;
}
function idParam(req:express.Request){return String(req.params.id);}
function unlocked(id:string){if(activeJobs.has(id)||isWorkflowActive(id))throw error(409,'课程正在处理，请任务完成后再修改。');}
function numeric(value:unknown):number|undefined{if(value===undefined||value===null||value==='')return undefined;if(typeof value!=='number'||!Number.isFinite(value))throw error(400,'时间必须是有效的秒数。');return value;}
function mediaPath(course:Course){return course.media?path.join(mediaDir,path.basename(course.media.url)):undefined;}

app.get('/api/local-model',route(async(_req,res)=>res.json(await localModelStatus())));
app.get('/api/local-asr',route(async(_req,res)=>res.json(await localAsrStatus())));
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'video-course-assistant'}));
app.get('/api/courses',route(async(_req,res)=>res.json(await listCourses())));
app.post('/api/courses',route(async(req,res)=>{
  await uploadRequest(req,res);
  const files=uploaded(req);
  try{
    const title=typeof req.body.title==='string'?req.body.title.trim().slice(0,200):'';
    const now=new Date().toISOString();
    const course:Course={id:randomUUID(),title:title||originalName(files[0]?.originalname||'未命名课程').replace(/\.[^.]+$/,''),createdAt:now,updatedAt:now,documents:[],cues:[],chapters:[],timing:'none',language:'zh',keywords:normalizeKeywords(req.body.keywords)};
    await addFiles(course,files,typeof req.body.transcript==='string'?req.body.transcript:undefined);
    await saveCourse(course);res.status(201).json(course);
  }catch(e){await cleanup(files);throw e;}
}));
app.get('/api/courses/:id',route(async(req,res)=>res.json(await getCourse(idParam(req)))));
app.patch('/api/courses/:id',route(async(req,res)=>{
  const id=idParam(req);unlocked(id);const course=await getCourse(id);
  if(req.body.title!==undefined){if(typeof req.body.title!=='string'||!req.body.title.trim())throw error(400,'请输入课程名称。');course.title=req.body.title.trim().slice(0,200);}
  if(req.body.keywords!==undefined)course.keywords=normalizeKeywords(req.body.keywords);
  const duration=numeric(req.body.duration);
  if(duration!==undefined){if(duration<=0||duration>7*24*3600)throw error(400,'时长必须在 0 秒到 7 天之间。');if(course.media)course.media.duration=duration;retimeEstimated(course,duration);}
  res.json(await saveCourse(course));
}));
app.delete('/api/courses/:id',route(async(req,res)=>{unlocked(idParam(req));await removeCourse(idParam(req));await removeWorkflow(idParam(req));res.status(204).end();}));
app.post('/api/courses/:id/files',route(async(req,res)=>{
  const id=idParam(req);unlocked(id);const course=await getCourse(id);
  await uploadRequest(req,res);const files=uploaded(req);
  try {const old=await addFiles(course,files,typeof req.body.transcript==='string'?req.body.transcript:undefined);await saveCourse(course);if(old)await fs.rm(old,{force:true});res.json(course);}catch(e){await cleanup(files);throw e;}
}));
app.get('/api/courses/:id/highlights',route(async(req,res)=>{const course=await getCourse(idParam(req));res.json(extractHighlights(course,req.query.keywords===undefined?course.keywords:normalizeKeywords(req.query.keywords)));}));
app.get('/api/courses/:id/export',route(async(req,res)=>{
  const course=await getCourse(idParam(req));const result=exportCourse(course,String(req.query.format||'md'),normalizeKeywords(req.query.keywords));
  res.setHeader('Content-Type',`${result.mime}; charset=utf-8`);res.setHeader('Content-Disposition',`attachment; filename="course.${result.extension}"; filename*=UTF-8''${encodeURIComponent(course.title+'.'+result.extension)}`);res.setHeader('X-Timing',course.timing);res.send(result.body);
}));
app.post('/api/courses/:id/chat',route(async(req,res)=>{
  const course=await getCourse(idParam(req));const question=req.body.question;
  if(typeof question!=='string'||!question.trim()||question.length>5000)throw error(400,'请输入 1 到 5000 字的问题。');
  const start=numeric(req.body.start),end=numeric(req.body.end);selectCues(course,start,end);
  const settings=await effectiveLocalSettings(await getSettings());
  if(req.body.useVision&&!isProviderConfigured(settings))throw error(400,'结合画面答疑需要先连接支持视觉的 AI 模型。');
  if(!isProviderConfigured(settings))return res.json(localChat(course,question,start,end));
  const history=Array.isArray(req.body.history)?req.body.history.slice(-20).filter((m:unknown)=>m&&typeof m==='object'&&['user','assistant'].includes((m as {role:string}).role)&&typeof (m as {content:unknown}).content==='string').map((m:{role:'user'|'assistant';content:string})=>({role:m.role,content:m.content.slice(0,8000)})):[];
  res.json(await chatWithCourse(course,settings,{question:question.trim(),start,end,history,useVision:!!req.body.useVision,mediaPath:mediaPath(course)}));
}));
app.get('/api/settings',route(async(_req,res)=>res.json(publicSettings(await effectiveLocalSettings(await getSettings())))));
app.put('/api/settings',route(async(req,res)=>{
  const settings=await getSettings();
  for(const key of ['baseUrl','model','speechModel','language'] as const){if(req.body[key]!==undefined){if(typeof req.body[key]!=='string'||req.body[key].length>2048)throw error(400,'模型设置字段无效。');settings[key]=req.body[key].trim();}}
  if(settings.baseUrl){let url:URL;try{url=new URL(settings.baseUrl);}catch{throw error(400,'接口地址格式无效。');}if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw error(400,'接口地址只能是无凭据的 HTTP(S) 地址。');}
  if(req.body.apiKey!==undefined){if(typeof req.body.apiKey!=='string'||req.body.apiKey.length>4096)throw error(400,'API Key 格式无效。');settings.apiKey=req.body.apiKey.trim();}
  if(req.body.terminologyOnly!==undefined)settings.terminologyOnly=!!req.body.terminologyOnly;
  if(req.body.speechEngine!==undefined){if(!['local','api'].includes(req.body.speechEngine))throw error(400,'语音引擎无效。');settings.speechEngine=req.body.speechEngine;}
  if(req.body.reasoningEffort!==undefined){if(!['none','low','medium','high'].includes(req.body.reasoningEffort))throw error(400,'思考强度无效。');settings.reasoningEffort=req.body.reasoningEffort;}
  await saveSettings(settings);res.json(publicSettings(settings));
}));
app.post('/api/settings/test',route(async(_req,res)=>res.json(await testProvider(await effectiveLocalSettings(await getSettings())))));
app.get('/api/models',route(async(_req,res)=>res.json({models:await listProviderModels(await effectiveLocalSettings(await getSettings()))})));
app.post('/api/courses/:id/jobs',route(async(req,res)=>{
  const course=await getCourse(idParam(req));unlocked(course.id);const type=req.body.type;
  if(!['transcribe','translate','correct','summarize'].includes(type))throw error(400,'不支持的处理任务。');
  const settings=await effectiveLocalSettings(await getSettings());
  if(req.body.engine!==undefined&&!['local','api'].includes(req.body.engine))throw error(400,'语音引擎无效。');
  const speechEngine=req.body.engine||settings.speechEngine||'local';
  settings.speechEngine=speechEngine;
  const local=type==='transcribe'&&speechEngine==='local';
  if(local){const status=await localAsrStatus();if(!status.ready)throw error(400,status.message);}
  else if(!isProviderConfigured(settings))throw error(400,'请先在模型设置中连接 AI；语音转录也可使用本地识别，无需 API Key。');
  const start=numeric(req.body.start),end=numeric(req.body.end);selectCues(course,start,end);
  unlocked(course.id);const job:Job={id:randomUUID(),courseId:course.id,type,status:'queued',progress:'等待处理',createdAt:new Date().toISOString()};jobs.set(job.id,job);activeJobs.add(course.id);
  // Keep bounded terminal job history; active jobs are never evicted.
  if(jobs.size>500)for(const [id,j]of jobs){if(j.status==='done'||j.status==='error'){jobs.delete(id);if(jobs.size<=400)break;}}
  res.status(202).json(job);
  void (async()=>{try{job.status='running';job.progress='正在处理';const options={type,start,end,mediaPath:mediaPath(course),onProgress:(message:string)=>{job.progress=message;}};const updated=local?await runLocalRecognition(course,options):await runCourseJob(course,settings,options);await saveCourse(updated);job.status='done';job.progress='处理完成';}catch(e){job.status='error';job.error=(e as Error).message||'任务失败，请检查模型配置。';job.progress='处理失败';}finally{activeJobs.delete(course.id);}})();
}));
app.get('/api/courses/:id/workflow',route(async(req,res)=>{await getCourse(idParam(req));res.json(await getWorkflow(idParam(req)));}));
app.post('/api/courses/:id/workflow',route(async(req,res)=>{
 const id=idParam(req);unlocked(id);
 const body=req.body;
 if(body.targetLanguage!==undefined&&(typeof body.targetLanguage!=='string'||body.targetLanguage.length>80))throw error(400,'文档目标语言无效。');
 if(body.keywords!==undefined&&!Array.isArray(body.keywords)&&typeof body.keywords!=='string')throw error(400,'关键词格式无效。');
 res.status(202).json(await startWorkflow(id,{keywords:body.keywords===undefined?undefined:normalizeKeywords(body.keywords),targetLanguage:body.targetLanguage,terminologyOnly:!!body.terminologyOnly,useExistingTranscript:!!body.useExistingTranscript,translate:!!body.translate}));
}));
app.get('/api/courses/:id/report',route(async(req,res)=>{
 await getCourse(idParam(req));const state=await getWorkflow(idParam(req));if(!state?.report)throw error(404,'课程文稿尚未生成。');
 const format=String(req.query.format||'md');if(format==='json')return res.json(state.report);if(format!=='md')throw error(400,'课程文稿仅支持 Markdown 或 JSON。');
 res.setHeader('Content-Type','text/markdown; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="study-report.md"; filename*=UTF-8''${encodeURIComponent(state.report.title+'-课程文稿.md')}`);res.send(state.report.markdown);
}));
app.get('/api/courses/:id/reviews',route(async(req,res)=>{await getCourse(idParam(req));res.json((await getWorkflow(idParam(req)))?.audit||[]);}));
app.post('/api/courses/:id/reviews/:reviewId/recheck',route(async(req,res)=>{unlocked(idParam(req));res.status(202).json(await startAuditRecheck(idParam(req),String(req.params.reviewId)));}));
app.patch('/api/courses/:id/reviews/:reviewId',route(async(req,res)=>{if(activeJobs.has(idParam(req)))throw error(409,'课程正在处理，请任务完成后再审查。');res.json(await reviewWorkflowItem(idParam(req),String(req.params.reviewId),{status:req.body.status,note:req.body.note,correctedText:req.body.correctedText,excludeFromReport:req.body.excludeFromReport}));}));
app.get('/api/jobs/:id',(req,res)=>{const job=jobs.get(idParam(req));if(!job)return res.status(404).json({error:'任务不存在或服务已重启，请刷新课程查看已保存结果。'});res.json(job);});
app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在。'}));
const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist=path.join(projectRoot,'dist');
try {await fs.access(path.join(dist,'index.html'));app.use(express.static(dist));app.get('/{*path}',(_req,res)=>res.sendFile(path.join(dist,'index.html')));}catch{/* Vite handles the development frontend. */}
app.use((err:Error & {status?:number;statusCode?:number;code?:string},_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const status=err instanceof multer.MulterError?(err.code==='LIMIT_FILE_SIZE'?413:400):(err.status||err.statusCode||500);
  res.status(status>=400&&status<600?status:500).json({error:err instanceof multer.MulterError?(err.code==='LIMIT_FILE_SIZE'?'文件超过 1 GiB 上传限制。':'上传文件数量或字段超过限制。'):status<500||err instanceof ProviderError?err.message:'服务处理失败，请检查终端日志或模型连接。'});
  if(status>=500)console.error(`[api] ${err.name}: ${err.message.replace(/(?:Bearer\s+|sk-)[\w-]+/gi,'[redacted]')}`);
});
// Keep demonstration material separate from user uploads, and never reseed a nonempty library.
if(!(await listCourses()).length){try{const text=await fs.readFile(path.join(projectRoot,'examples/course.md'),'utf8');const now=new Date().toISOString();await saveCourse({id:randomUUID(),title:'计算机绘图 · 剖视图与断面图',createdAt:now,updatedAt:now,documents:[{id:randomUUID(),name:'示例课程节选.md',type:'md',text}],...parseTranscript(text,'示例课程节选.md'),language:'zh',keywords:['作业','大作业','期末','开卷','下节课','提醒']});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
void ensureLocalModelServer().catch(()=>{});
const port=Number(process.env.PORT||3001),host=process.env.HOST||'127.0.0.1';
app.listen(port,host,()=>console.log(`Course assistant API listening on ${host}:${port}; data: ${path.basename(dataDir)}`));
export { app };
