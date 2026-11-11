import {test} from 'node:test';
import assert from 'node:assert/strict';
import {zipSync,strToU8} from 'fflate';
import {parsePptx} from '../server/documents.ts';
const slide=(text:string)=>strToU8(`<p:sld><a:t>${text}</a:t></p:sld>`);
test('PPTX text extraction orders slides numerically, preserves entities, skips notes',()=>{
 const file=zipSync({'ppt/slides/slide10.xml':slide('第十页'),'ppt/slides/slide2.xml':slide('A &amp; B &#x4e2d;'),'ppt/notesSlides/notesSlide1.xml':slide('不包含备注')});
 const text=parsePptx(file);assert.ok(text.indexOf('A & B 中')<text.indexOf('第十页'));assert.doesNotMatch(text,/不包含备注/);
});
test('PPTX rejects oversized inflated slides and aggregate size before decompression',()=>{
 const oversized=zipSync({'ppt/slides/slide1.xml':slide('x'.repeat(2*1024*1024))});
 assert.throws(()=>parsePptx(oversized),/解压后的/);
 const files:Record<string,Uint8Array>={};for(let i=1;i<=6;i++)files[`ppt/slides/slide${i}.xml`]=slide('x'.repeat(1800000));
 assert.throws(()=>parsePptx(zipSync(files)),/解压后的/);
});
test('PPTX rejects non-archives, image-only decks, and too many slides',()=>{
 assert.throws(()=>parsePptx(strToU8('not a zip')),/解析失败/);
 assert.throws(()=>parsePptx(zipSync({'ppt/slides/slide1.xml':strToU8('<p:sld/>')})),/没有可提取/);
 const files:Record<string,Uint8Array>={};for(let i=1;i<=501;i++)files[`ppt/slides/slide${i}.xml`]=slide('课程');
 assert.throws(()=>parsePptx(zipSync(files)),/500 页/);
});
test('PPTX respects presentation relationship order after slides are rearranged',()=>{
 const file=zipSync({
  'ppt/slides/slide1.xml':slide('最初创建'),
  'ppt/slides/slide2.xml':slide('现在第一页'),
  'ppt/presentation.xml':strToU8('<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>'),
  'ppt/_rels/presentation.xml.rels':strToU8('<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>')
 });
 const text=parsePptx(file);assert.ok(text.indexOf('现在第一页')<text.indexOf('最初创建'));
});
