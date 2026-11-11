import { unzipSync, strFromU8 } from 'fflate';
const problem=(status:number,message:string)=>Object.assign(new Error(message),{status});
const decodeXml=(v:string)=>v.replace(/&#(x[0-9a-f]+|[0-9]+);/gi,(_m,code:string)=>{const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):parseInt(code,10);return n>=0&&n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
/** Extract text-only slide content with platform-independent, bounded ZIP inflation. */
export function parsePptx(bytes: Uint8Array):string {
  let count=0,slides=0,totalSize=0;
  let files:Record<string,Uint8Array>;
  try {
    files=unzipSync(bytes,{filter:file=>{
      if(++count>2000)throw problem(413,'PPTX 中的文件过多，请拆分上传。');
      const isSlide=/^ppt\/slides\/slide\d+\.xml$/.test(file.name);
      if(!isSlide && !['ppt/presentation.xml','ppt/_rels/presentation.xml.rels'].includes(file.name))return false;
      if(isSlide&&++slides>500)throw problem(413,'PPTX 超过 500 页，请拆分上传。');
      totalSize+=file.originalSize;
      if(file.originalSize>2*1024*1024||totalSize>10*1024*1024)throw problem(413,'PPTX 解压后的幻灯片文字过大，请拆分上传。');
      return true;
    }});
  }catch(e){if((e as {status?:number}).status)throw e;throw problem(422,'PPTX 解析失败，请检查文件，或导出 PDF / TXT 后导入。');}
  let ordered=Object.keys(files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b)=>Number(a.match(/slide(\d+)/)![1])-Number(b.match(/slide(\d+)/)![1]));
  // Actual slideshow order can differ from slide filenames after rearranging slides.
  if(files['ppt/presentation.xml']&&files['ppt/_rels/presentation.xml.rels']) {
    const attrs=(tag:string)=>Object.fromEntries([...tag.matchAll(/([\w:]+)\s*=\s*["']([^"']*)["']/g)].map(m=>[m[1],decodeXml(m[2])]));
    const relations=new Map<string,string>();
    for(const m of strFromU8(files['ppt/_rels/presentation.xml.rels']).matchAll(/<Relationship\b[^>]*>/g)) {
      const a=attrs(m[0]);
      if(a.TargetMode==='External'||!a.Id||!a.Target)continue;
      const target=a.Target.startsWith('/')?a.Target.slice(1):'ppt/'+a.Target.replace(/^\.\//,'');
      if(/^ppt\/slides\/slide\d+\.xml$/.test(target))relations.set(a.Id,target);
    }
    const references=[...strFromU8(files['ppt/presentation.xml']).matchAll(/<p:sldId\b[^>]*>/g)].map(m=>relations.get(attrs(m[0])['r:id']));
    if(references.some(name=>!name||!files[name]))throw problem(422,'PPTX 幻灯片引用损坏，请重新导出后上传。');
    if(references.length)ordered=references as string[];
  }
  const texts=ordered.map((name,i)=>({index:i+1,text:[...strFromU8(files[name]).matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m=>decodeXml(m[1])).join('\n')})).filter(s=>s.text.trim());
  if(!texts.length)throw problem(422,'PPTX 中没有可提取的文字；图片幻灯片请另行提供视频或可识别文字稿。');
  return texts.map(slide=>`## 第 ${slide.index} 页\n${slide.text}`).join('\n\n');
}
