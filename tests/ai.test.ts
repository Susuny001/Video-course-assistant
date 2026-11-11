import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatWithCourse, runCourseJob, selectedCues, testProvider } from '../server/ai.js';
import type { Course, ProviderSettings } from '../src/types.js';

const settings: ProviderSettings = {baseUrl:'https://models.example/v1',apiKey:'private-key-not-to-expose',model:'study-model',speechModel:'whisper-1',language:'英语',terminologyOnly:false,reasoningEffort:'none'};
const course: Course = {id:'course',title:'绘图课',createdAt:'',updatedAt:'',language:'zh',timing:'exact',keywords:[],documents:[],cues:[{id:'a',start:0,end:10,text:'期末开卷考试。',chapterId:'chapter'},{id:'b',start:10,end:20,text:'断面图只画剖切处。',chapterId:'chapter'}],chapters:[{id:'chapter',title:'课程内容',start:0,end:20,summary:'原有摘要',cueIds:['a','b']}]};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function mockCompletion(content: unknown) { globalThis.fetch = async () => Response.json({choices:[{message:{content:JSON.stringify(content)}}]}); }

test('selected range keeps only overlapping cues and validates malformed ranges', () => {
  assert.deepEqual(selectedCues(course,10,19).map(c => c.id),['b']);
  assert.throws(() => selectedCues(course,-1,10),/片段范围无效/);
  assert.throws(() => selectedCues(course,10,10),/片段范围无效/);
  assert.throws(() => selectedCues(course,NaN,20),/片段范围无效/);
});
test('translation validates IDs and only updates selected cues without changing originals', async () => {
  let requestBody: any;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({choices:[{message:{content:'[{"id":"b","translation":"A section shows only the cut surface."}]'}}]});
  };
  const result = await runCourseJob(course,settings,{type:'translate',start:10,end:20});
  assert.equal(result.cues[1].translation,'A section shows only the cut surface.');
  assert.equal(result.cues[0].translation,undefined);
  assert.equal(result.cues[1].text,course.cues[1].text);
  assert.equal(course.cues[1].translation,undefined);
  assert.equal(requestBody.model,'study-model');
  assert.match(requestBody.messages[0].content,/不可信/);
  assert.doesNotMatch(requestBody.messages.at(-1).content,/期末开卷/);
});
test('translation rejects missing or invented cue IDs and preserves source', async () => {
  mockCompletion([{id:'invented',translation:'Text'}]);
  await assert.rejects(runCourseJob(course,settings,{type:'translate'}),/ID/);
  mockCompletion([{id:'a',translation:'Open book.'}]);
  await assert.rejects(runCourseJob(course,settings,{type:'translate'}),/漏掉/);
  assert.equal(course.cues[0].translation,undefined);
});
test('chat returns source references only for evidence actually supplied', async () => {
  mockCompletion({answer:'断面图展示剖切处。',sourceIds:['b','b']});
  const result = await chatWithCourse(course,settings,{question:'断面图是什么',start:10,end:20});
  assert.equal(result.mode,'ai');
  assert.equal(result.sources.length,1);
  assert.equal(result.sources[0].cueId,'b');
  mockCompletion({answer:'引用了选段外内容。',sourceIds:['a']});
  await assert.rejects(chatWithCourse(course,settings,{question:'断面图是什么',start:10,end:20}),/不存在的位置/);
});
test('provider failures never expose echoed API key or private content', async () => {
  globalThis.fetch = async () => new Response('secret '+settings.apiKey,{status:500});
  await assert.rejects(testProvider(settings), (error: Error) => {
    assert.match(error.message,/HTTP 500/);
    assert.ok(!error.message.includes(settings.apiKey!));
    return true;
  });
});
test('provider test allows keyless local Ollama and reports model availability', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input,'http://localhost:11434/v1/models');
    assert.ok(!('Authorization' in (init!.headers as Record<string,string>)));
    return Response.json({data:[{id:'qwen2.5:7b'}]});
  };
  const result = await testProvider({...settings,apiKey:'',baseUrl:'http://localhost:11434/v1',model:'qwen2.5:7b'});
  assert.equal(result.ok,true);
});
test('remote HTTP and URL-embedded credentials are rejected before request', async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return Response.json({}); };
  await assert.rejects(testProvider({...settings,baseUrl:'http://remote.example/v1'}),/HTTPS/);
  await assert.rejects(testProvider({...settings,baseUrl:'https://user:password@remote.example/v1'}),/账号/);
  assert.equal(fetched,false);
});
test('vision correction refuses to invent visual evidence from audio or transcript', async () => {
  await assert.rejects(runCourseJob(course,settings,{type:'correct'}),/视觉分析需要上传视频/);
});
test('real ffmpeg audio slicing preserves timestamp offsets from transcription API', async () => {
  const directory = await mkdtemp(join(tmpdir(),'course-ai-test-'));
  try {
    const path = join(directory,'sample.wav');
    execFileSync('ffmpeg',['-nostdin','-y','-v','error','-f','lavfi','-i','sine=frequency=440:duration=3',path]);
    globalThis.fetch = async (input, init) => {
      assert.equal(input,'https://models.example/v1/audio/transcriptions');
      const form = init!.body as FormData;
      assert.equal(form.get('response_format'),'verbose_json');
      const file = form.get('file') as File;
      assert.ok(file.size > 100);
      assert.ok(file.size < 20 * 1024 * 1024);
      return Response.json({segments:[{start:0,end:1.5,text:'测试转录内容'}]});
    };
    const input = {...course,media:{url:'/media/sample.wav',name:'sample.wav',type:'audio/wav'}};
    const result = await runCourseJob(input,settings,{type:'transcribe',start:1,end:3,mediaPath:path});
    assert.equal(result.cues.length,2); // replaced the overlapping cue; later cue remains untouched
    assert.equal(result.cues[0].start,1);
    assert.equal(result.cues[0].end,2.5);
    assert.equal(result.cues[0].text,'测试转录内容');
    assert.equal(result.timing,'exact');
    assert.equal(course.cues[0].text,'期末开卷考试。');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('visual correction combines independently transcribed audio with real sampled frames and preserves original text', async () => {
  const directory = await mkdtemp(join(tmpdir(),'course-vision-test-'));
  try {
    const path = join(directory,'sample.mp4');
    execFileSync('ffmpeg',['-nostdin','-y','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=25:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-shortest','-c:v','mpeg4','-c:a','aac',path]);
    let speechRequest = false;
    let visualRequest = false;
    globalThis.fetch = async (input,init) => {
      if (String(input).endsWith('/audio/transcriptions')) {
        speechRequest = true;
        return Response.json({segments:[{start:0,end:2,text:'断面图只显示剖切处。'}]});
      }
      const body = JSON.parse(String(init?.body));
      const content = body.messages.at(-1).content;
      assert.ok(Array.isArray(content));
      assert.equal(content.filter((item:any) => item.type === 'image_url').length,3);
      assert.match(content[0].text,/speechEvidence/);
      assert.match(content[0].text,/断面图只显示剖切处/);
      visualRequest = true;
      return Response.json({choices:[{message:{content:'[{"id":"a","correctedText":"断面图只显示剖切处。"}]'}}]});
    };
    const input: Course = {...course,media:{url:'/media/sample.mp4',name:'sample.mp4',type:'video/mp4'},cues:[{id:'a',start:0,end:2,text:'断面图只显示破切处。'}],chapters:[]};
    const result = await runCourseJob(input,settings,{type:'correct',mediaPath:path});
    assert.ok(speechRequest && visualRequest);
    assert.equal(result.cues[0].correctedText,'断面图只显示剖切处。');
    assert.equal(result.cues[0].text,'断面图只显示破切处。');
    assert.equal(input.cues[0].correctedText,undefined);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
