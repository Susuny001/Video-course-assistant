import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Course, ProviderSettings } from '../src/types.ts';
export const dataDir=path.resolve(process.env.DATA_DIR || 'data');
export const mediaDir=path.join(dataDir,'media');
const courseDir=path.join(dataDir,'courses');
export const defaultSettings: ProviderSettings={baseUrl:'',model:'',speechModel:'whisper-1',language:'en',terminologyOnly:false,reasoningEffort:'none'};
export async function initializeStorage(){ await fs.mkdir(courseDir,{recursive:true}); await fs.mkdir(mediaDir,{recursive:true}); }
function coursePath(id:string){if(!/^[\w-]{1,100}$/.test(id)) throw Object.assign(new Error('课程不存在。'),{status:404}); return path.join(courseDir,`${id}.json`);}
async function writeAtomic(filename:string,value:unknown){const temp=`${filename}.${randomUUID()}.tmp`;try {await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(temp,filename);} finally {await fs.rm(temp,{force:true});}}
export async function listCourses():Promise<Course[]>{const files=await fs.readdir(courseDir);const courses=await Promise.all(files.filter(f=>f.endsWith('.json')).map(f=>fs.readFile(path.join(courseDir,f),'utf8').then(JSON.parse)));return courses.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
export async function getCourse(id:string):Promise<Course>{try{return JSON.parse(await fs.readFile(coursePath(id),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw Object.assign(new Error('课程不存在。'),{status:404});throw e;}}
export async function saveCourse(course:Course){course.updatedAt=new Date().toISOString();await writeAtomic(coursePath(course.id),course);return course;}
export async function removeCourse(id:string){const course=await getCourse(id);await fs.rm(coursePath(id));if(course.media?.url){const basename=path.basename(course.media.url);await fs.rm(path.join(mediaDir,basename),{force:true});}}
export async function getSettings():Promise<ProviderSettings>{try{return {...defaultSettings,...JSON.parse(await fs.readFile(path.join(dataDir,'provider.json'),'utf8'))};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {...defaultSettings};throw e;}}
export async function saveSettings(settings:ProviderSettings){await writeAtomic(path.join(dataDir,'provider.json'),settings);}
export function publicSettings(settings:ProviderSettings){const {apiKey,...rest}=settings;return {...rest,hasApiKey:!!apiKey};}
