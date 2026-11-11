import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, extractHighlights, selectCues, retimeEstimated, exportCourse, localChat } from '../server/processing.ts';
import type { Course } from '../src/types.ts';
const build=(text:string,filename='lecture.md'):Course=>({id:'test',title:'测试',createdAt:'',updatedAt:'',documents:[],language:'zh',keywords:[],...parseTranscript(text,filename)});
test('markdown headings create chapters while sentence text stays intact and timing is estimated',()=>{
 const c=build('# 课程\n\n## 考试\n开卷考试，两小时。可以带一本书！\n\n## 作业\n本周做第3章习题。');
 assert.equal(c.timing,'estimated');assert.deepEqual(c.chapters.map(ch=>ch.title),['考试','作业']);assert.equal(c.cues.length,3);assert.equal(c.cues[1].text,'可以带一本书！');
 assert.equal(c.chapters[0].cueIds.length,2);assert.equal(c.chapters[1].start,c.cues[2].start);
});
test('SRT and WebVTT preserve real timestamps and multiline text',()=>{
 const c=build('1\n00:00:01,250 --> 00:00:03,500\n中文\nEnglish\n\n2\n00:00:04,000 --> 00:00:07,000\n第二句\n','lecture.srt');
 assert.equal(c.timing,'exact');assert.equal(c.cues[0].start,1.25);assert.equal(c.cues[0].end,3.5);assert.equal(c.cues[0].text,'中文\nEnglish');
 const v=build('WEBVTT\n\n00:01.000 --> 00:03.000 align:start\n字幕\n','x.vtt');assert.equal(v.cues[0].start,1);
 assert.throws(()=>parseTranscript('bad subtitles','bad.srt'),/有效时间轴/);
});
test('keyword context is literal, case-insensitive, merged and bounded to one chapter',()=>{
 const c=build('## 单元一\nAutoCAD 可以复制。CAD 可以裁剪。其他内容。CAD 是绘图软件。\n## 单元二\nCAD 作业。');
 const h=extractHighlights(c,['cad','[.*]']);assert.equal(h.length,2);assert.equal(h[0].cueIds.length,4);assert.match(h[0].excerpt,/AutoCAD/);assert.equal(h[1].chapterId,c.chapters[1].id);
 assert.equal(extractHighlights(c,['不存在']).length,0);
});
test('range uses overlap boundaries and rejects invalid ranges',()=>{
 const c=build('1\n00:00:00,000 --> 00:00:02,000\nA\n\n2\n00:00:02,000 --> 00:00:04,000\nB','x.srt');
 assert.equal(selectCues(c,2,4).length,1);assert.equal(selectCues(c,1,3).length,2);assert.throws(()=>selectCues(c,4,2));assert.throws(()=>selectCues(c,-1,3));
});
test('retiming rescales estimated chapter and cue boundaries but never changes timestamped subtitles',()=>{
 const c=build('## 章节\n第一句。第二句。');retimeEstimated(c,100);assert.equal(c.cues.at(-1)!.end,100);assert.equal(c.chapters[0].end,100);
 const timed=build('1\n00:00:01,000 --> 00:00:05,000\n原始','x.srt');retimeEstimated(timed,100);assert.equal(timed.cues[0].end,5);
});
test('exports preserve corrections and translations without losing original JSON and flag estimated timing',()=>{
 const c=build('原文。');c.cues[0].correctedText='校对后。';c.cues[0].translation='Translation.';
 assert.match(exportCourse(c,'srt').body,/校对后。\nTranslation\./);assert.equal(JSON.parse(exportCourse(c,'json').body).cues[0].text,'原文。');assert.match(exportCourse(c,'vtt').body,/NOTE 时间为估算/);assert.match(exportCourse(c,'md').body,/未经音视频对齐/);assert.throws(()=>exportCourse(c,'exe'));
});
test('local answers cite retrieved text and do not invent answers when no match exists',()=>{
 const c=build('## 考试\n期末考试开卷，两小时。');const answer=localChat(c,'考试是什么形式？');assert.equal(answer.mode,'local');assert.equal(answer.sources.length,1);assert.match(answer.answer,/本地检索/);assert.equal(localChat(c,'光合作用').sources.length,0);
});
test('Markdown export retains verbatim imported sources separately from corrected subtitles',()=>{
 const c=build('原始术语。');c.cues[0].correctedText='修订术语。';c.documents=[{id:'source',name:'课程.md',type:'md',text:'## 原标题\n原始术语。\n```code```'}];
 const output=exportCourse(c,'md').body;assert.match(output,/修订术语/);assert.match(output,/导入文档原稿（逐字保留）/);assert.ok(output.includes(c.documents[0].text));assert.match(output,/````text/);
});

test('exam keyword retains score details from its numbered source item and excludes the next item',()=>{
 const c=build('## 通知\n3. 没有期中考试。\n4. 期末笔试：开卷，两小时。题型：\n- 30分填空和选择\n- 70分画图分析\n- 请提前复习教材。\n5. 本周作业3-1。');
 const h=extractHighlights(c,['期末','不存在']);assert.equal(h.length,1);assert.match(h[0].excerpt,/30分/);assert.match(h[0].excerpt,/70分/);assert.doesNotMatch(h[0].excerpt,/本周作业/);assert.doesNotMatch(h[0].excerpt,/期中/);assert.equal(h[0].keyword,'期末');assert.equal(h[0].cueIds.length,5);
});
test('unstructured keyword windows include context and merge overlap without crossing chapters',()=>{
 const c=build('## 第一章\n前情。目标词出现。解释甲。解释乙。无关结尾。\n## 第二章\n其他内容。');
 const h=extractHighlights(c,['目标词']);assert.equal(h.length,1);assert.match(h[0].excerpt,/前情/);assert.match(h[0].excerpt,/解释乙/);assert.doesNotMatch(h[0].excerpt,/无关结尾|其他内容/);assert.equal(h[0].cueIds.length,4);
});
