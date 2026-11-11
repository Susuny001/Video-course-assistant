import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const exec=promisify(execFile);
async function comparison(first:unknown,second:unknown){
 const temp=await mkdtemp(join(tmpdir(),'independent-audit-test-'));
 try{const a=join(temp,'a.json'),b=join(temp,'b.json'),out=join(temp,'audit.json');await writeFile(a,JSON.stringify(first));await writeFile(b,JSON.stringify(second));await exec('python3',['scripts/compare-transcripts.py','--primary',a,'--secondary',b,'--output',out]);return JSON.parse(await readFile(out,'utf8'));}finally{await rm(temp,{recursive:true,force:true});}
}
const source='same-audio-sha';
test('independent acoustic review flags exam number mismatch and preserves both original outputs',async()=>{
 const first={sourceSha256:source,model:'SenseVoice',segments:[{start:1,end:8,text:'期末考试开卷，三十分填空选择，七十分画图分析。'}]};
 const second={sourceSha256:source,model:'Paraformer',segments:[{start:1,end:8,text:'期末考试开卷，30分填空选择，60分画图分析。'}]};
 const result=await comparison(first,second);assert.equal(result.reviewComplete,false);assert.equal(result.items[0].priority,'high');assert.ok(result.items[0].reasons.includes('numeric_fact_disagreement'));assert.equal(result.items[0].primaryText,first.segments[0].text);assert.equal(result.items[0].secondaryText,second.segments[0].text);
});
test('equivalent numeric rendering agrees acoustically while missing second-model speech remains visible',async()=>{
 const first={sourceSha256:source,model:'A',segments:[{start:1,end:3,text:'考试三十分。'},{start:5,end:8,text:'下周交作业。'}]};
 const second={sourceSha256:source,model:'B',segments:[{start:1,end:3,text:'考试30分。'}]};
 const result=await comparison(first,second);assert.equal(result.items[0].status,'acoustic_agreement');assert.equal(result.items[1].priority,'high');assert.ok(result.items[1].reasons.includes('one_model_missing_speech'));
});
test('independent review rejects results from different audio rather than certifying unrelated outputs',async()=>{
 await assert.rejects(()=>comparison({sourceSha256:'a',segments:[]},{sourceSha256:'b',segments:[]}),/不同音频/);
});
test('actual independent Paraformer model decodes public Mandarin speech with absolute audio boundaries',async t=>{
 const python=process.platform==='win32'?'data/local-asr/venv/Scripts/python.exe':'data/local-asr/venv/bin/python';
 const model='data/local-asr/paraformer/model';const audio='data/local-asr/model/test_wavs/zh.wav';
 try{await access(python);await access(join(model,'model.int8.onnx'));await access(audio);}catch{t.skip('Independent acoustic model assets absent; run both local ASR installers.');return;}
 const temp=await mkdtemp(join(tmpdir(),'real-independent-asr-'));
 try{const output=join(temp,'result.json');await exec(python,['scripts/independent-transcribe.py','--audio',audio,'--model-dir',model,'--output',output,'--threads','1']);const result=JSON.parse(await readFile(output,'utf8'));assert.equal(result.model,'paraformer-zh-int8-2025-10-07');assert.equal(result.sourceSha256,'b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373');assert.ok(result.segments.length>0);assert.match(result.segments.map((v:{text:string})=>v.text).join(''),/时间|早上|下午/);for(const segment of result.segments){assert.ok(segment.start>=0);assert.ok(segment.end>segment.start);assert.ok(segment.end<=result.duration);}}finally{await rm(temp,{recursive:true,force:true});}
});
