import { randomUUID } from 'node:crypto';
import type { Course, Cue, Chapter, Highlight, ChatResult } from '../src/types.ts';

export function normalizeKeywords(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、\n]+/) : [];
  return [...new Set(values.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean))].slice(0, 30).map(v => v.slice(0, 80));
}
export function parseTime(value: string): number {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n) || n < 0) || parts.length < 2 || parts.length > 3) return NaN;
  return parts.reduce((n, p) => n * 60 + p, 0);
}
const clean = (text: string) => text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/^[-+]\s+/gm, '').trim();
function splitText(text: string): string[] {
  const sentences = clean(text).match(/[^。！？!?\n]+[。！？!?]?/g) || [];
  const result: string[] = [];
  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s || /^[-—]{3,}$/.test(s)) continue;
    // Bound subtitles to readable chunks without dropping content.
    for (let i = 0; i < s.length; i += 140) result.push(s.slice(i, i + 140));
  }
  return result;
}
function chapterSummary(cues: Cue[]): string {
  return cues.slice(0, 3).map(c => c.correctedText || c.text).join('').slice(0, 280);
}
export function chaptersFromCues(cues: Cue[]): Chapter[] {
  const chapters: Chapter[] = [];
  for (const cue of cues) {
    let chapter = chapters.at(-1);
    if (!chapter || cue.start - chapter.start >= 300) {
      chapter = {id: randomUUID(), title: cue.text.slice(0, 28), start: cue.start, end: cue.end, summary: '', cueIds: []};
      chapters.push(chapter);
    }
    cue.chapterId = chapter.id;
    chapter.cueIds.push(cue.id);
    chapter.end = Math.max(chapter.end, cue.end);
  }
  for (const chapter of chapters) chapter.summary = chapterSummary(cues.filter(c => c.chapterId === chapter.id));
  return chapters;
}
export function parseTranscript(text: string, filename = '文字稿.md', duration?: number): Pick<Course, 'cues'|'chapters'|'timing'> {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const timed: Cue[] = [];
  // A cue may carry WebVTT positioning settings; text is never interpreted as HTML.
  const timingPattern = /(?:^|\n)(?:\d+\n)?((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = timingPattern.exec(text))) {
    const start = parseTime(match[1]), end = parseTime(match[2]);
    const body = match[3].replace(/<[^>]+>/g, '').trim();
    if (body && Number.isFinite(start) && end > start) timed.push({id: randomUUID(), start, end, text: body});
  }
  if (timed.length) {
    timed.sort((a,b) => a.start - b.start);
    return {cues: timed, chapters: chaptersFromCues(timed), timing:'exact'};
  }
  if (/\.(?:srt|vtt)$/i.test(filename)) throw Object.assign(new Error('字幕文件没有可读取的有效时间轴，请检查 SRT / VTT 格式。'), {status:422});
  const groups: {title:string;text:string[]}[] = [];
  let title = filename.replace(/\.[^.]+$/, ''), current: typeof groups[number] | undefined;
  for (const line of text.split('\n')) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      title = clean(heading[2]);
      current = undefined;
    } else if (line.trim() && !/^\s*[-—]{3,}\s*$/.test(line)) {
      const chunks = splitText(line);
      if (!chunks.length) continue;
      if (!current) {current = {title, text:[]}; groups.push(current);}
      current.text.push(...chunks);
    }
  }
  const cues: Cue[] = [], chapters: Chapter[] = [];
  const weight = groups.flatMap(g => g.text).reduce((sum, t) => sum + Math.max(10, t.length), 0);
  const total = duration && duration > 0 ? duration : weight / 5;
  let cursor = 0;
  for (const group of groups) {
    const id = randomUUID(), chapterCues: Cue[] = [];
    for (const body of group.text) {
      const end = cursor + Math.max(10, body.length) / weight * total;
      const cue = {id:randomUUID(),start:Math.round(cursor * 1000)/1000,end:Math.round(end * 1000)/1000,text:body,chapterId:id};
      chapterCues.push(cue); cues.push(cue); cursor = end;
    }
    if (chapterCues.length) chapters.push({id,title:group.title,start:chapterCues[0].start,end:chapterCues.at(-1)!.end,summary:chapterSummary(chapterCues),cueIds:chapterCues.map(c=>c.id)});
  }
  return {cues,chapters,timing:cues.length?'estimated':'none'};
}
export function retimeEstimated(course: Course, duration: number): void {
  if (course.timing !== 'estimated' || !course.cues.length) return;
  const previousEnd = Math.max(...course.cues.map(c=>c.end));
  if (!previousEnd) return;
  const ratio = duration/previousEnd;
  for (const cue of course.cues) {cue.start *= ratio; cue.end *= ratio;}
  for (const chapter of course.chapters) {chapter.start *= ratio;chapter.end *= ratio;}
}
export function selectCues(course: Course, start?: number, end?: number): Cue[] {
  const s = start ?? 0, e = end ?? Infinity;
  if (!Number.isFinite(s) || s < 0 || !(e > s) || (end !== undefined && !Number.isFinite(e))) throw Object.assign(new Error('选段起止时间无效，结束时间必须晚于开始时间。'), {status:400});
  return course.cues.filter(c=>c.end > s && c.start < e);
}
export function extractHighlights(course: Course, keywords: string[]): Highlight[] {
  const result: Highlight[] = [];
  for (const keyword of normalizeKeywords(keywords)) {
    let previous: Highlight | undefined;
    let previousIndex = -2;
    for (let i=0;i<course.cues.length;i++) {
      const cue = course.cues[i];
      const body = cue.correctedText || cue.text;
      if (!body.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) continue;
      if (previous && previous.chapterId === (cue.chapterId || '') && previousIndex === i-1) {
        previous.cueIds.push(cue.id); previous.excerpt += '\n' + body; previous.end=cue.end;
      } else {
        previous = {id:`${cue.id}:${keyword}`,keyword,chapterId:cue.chapterId || '',cueIds:[cue.id],excerpt:body,start:cue.start,end:cue.end};
        result.push(previous);
      }
      previousIndex=i;
    }
  }
  return result.sort((a,b)=>a.start-b.start);
}
export function localChat(course: Course, question: string, start?: number, end?: number): ChatResult {
  const cues = selectCues(course,start,end);
  const terms = [...question.toLowerCase().matchAll(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g)].flatMap(m=>{
    const word=m[0];
    if (/^[\u3400-\u9fff]+$/.test(word) && word.length>2) return [word,...Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2))];
    return [word];
  }).filter(w=>!['什么','如何','怎么','一下','这个','哪些','请问','的区别','一下'].includes(w));
  const ranked = cues.map((cue,i)=>({cue,i,score:terms.reduce((n,t)=>n+((cue.correctedText||cue.text).toLowerCase().includes(t)?t.length:0),0)})).filter(v=>v.score>0).sort((a,b)=>b.score-a.score).slice(0,5).sort((a,b)=>a.i-b.i);
  const sources=ranked.map(({cue})=>({cueId:cue.id,start:cue.start,excerpt:cue.correctedText||cue.text}));
  return {mode:'local',sources,answer:sources.length ? `以下是文字稿中与你的问题相关的原文摘录（本地检索，未经 AI 推理）：\n\n${sources.map((s,i)=>`[${i+1}] ${s.excerpt}`).join('\n\n')}\n\n如需解释、翻译或结合画面分析，请在模型设置中连接 AI。` : '当前选段没有检索到直接相关的原文。请换一个更具体的课程关键词，或连接 AI 进行分析；本地检索不会补写课程里不存在的内容。'};
}
export function formatTime(seconds: number, separator = ','): string {
  const ms = Math.round(Math.max(0,seconds)*1000);
  return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}${separator}${String(ms%1000).padStart(3,'0')}`;
}
export function exportCourse(course: Course, format: string, keywords: string[] = []): {body:string;mime:string;extension:string} {
  if (format==='json') return {body:JSON.stringify(course,null,2),mime:'application/json',extension:'json'};
  if (format==='srt' || format==='vtt') {
    const header=format==='vtt'?`WEBVTT\n\nNOTE ${course.timing==='estimated'?'时间为估算，未与录音对齐':'已导入时间轴'}\n\n`:'';
    return {body:header+course.cues.map((c,i)=>`${i+1}\n${formatTime(c.start,format==='vtt'?'.':',')} --> ${formatTime(c.end,format==='vtt'?'.':',')}\n${c.correctedText||c.text}${c.translation?'\n'+c.translation:''}\n`).join('\n'),mime:format==='vtt'?'text/vtt':'application/x-subrip',extension:format};
  }
  if (format!=='md') throw Object.assign(new Error('不支持的导出格式。'),{status:400});
  const highlight=extractHighlights(course,keywords.length?keywords:course.keywords);
  const parts=[`# ${course.title}`,`时间轴：${course.timing==='estimated'?'估算，未经音视频对齐':course.timing==='exact'?'来自带时间戳字幕 / 语音转录':'无时间轴'}`,'## 章节摘要（本地摘要为原文摘录）',...course.chapters.map(ch=>`### ${ch.title}\n${formatTime(ch.start,'.')} — ${formatTime(ch.end,'.')}\n\n${ch.summary}`),'## 指定关键词重点',...(highlight.length?highlight.map(h=>`### ${h.keyword} · ${formatTime(h.start,'.')}\n\n${h.excerpt}`):['暂无匹配。']),'## 字幕',...course.cues.map(c=>`[${formatTime(c.start,'.')}] ${c.correctedText||c.text}${c.translation?'\n\n'+c.translation:''}`)];
  return {body:parts.join('\n\n'),mime:'text/markdown',extension:'md'};
}
