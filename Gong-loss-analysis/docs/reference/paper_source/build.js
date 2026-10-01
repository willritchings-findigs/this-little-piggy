const fs=require('fs');
const {Document,Packer,Paragraph,TextRun,HeadingLevel,AlignmentType,ImageRun,Table,TableRow,TableCell,WidthType,BorderStyle,ShadingType,LevelFormat,PageBreak,Footer,PageNumber}=require('docx');
const C=JSON.parse(fs.readFileSync('content.json','utf8'));
const FONT='Arial', SZ=21;
function runs(t,base={}){ // **bold** and *italic*
  const out=[]; const re=/(\*\*[^*]+\*\*|\*[^*]+\*)/g; let last=0,m;
  while((m=re.exec(t))){ if(m.index>last) out.push(new TextRun({text:t.slice(last,m.index),font:FONT,size:SZ,...base}));
    const tok=m[0]; if(tok.startsWith('**')) out.push(new TextRun({text:tok.slice(2,-2),bold:true,font:FONT,size:SZ,...base}));
    else out.push(new TextRun({text:tok.slice(1,-1),italics:true,font:FONT,size:SZ,...base})); last=m.index+tok.length; }
  if(last<t.length) out.push(new TextRun({text:t.slice(last),font:FONT,size:SZ,...base})); return out; }
const sizes={1:[1400,640],2:[1400,600],3:[1400,640],4:[1500,600],5:[1500,680],6:[1400,640],7:[1400,600],8:[1400,560],9:[1400,560]};
const kids=[];
const border={style:BorderStyle.SINGLE,size:4,color:'BFC5D2'};
for(const [t,v] of C){
  if(t==='title') kids.push(new Paragraph({spacing:{after:120},children:[new TextRun({text:v,bold:true,font:FONT,size:32,color:'1F3A5F'})]}));
  else if(t==='meta') kids.push(new Paragraph({spacing:{after:40},children:[new TextRun({text:v,font:FONT,size:17,color:'555555'})]}));
  else if(t==='h1') kids.push(new Paragraph({heading:HeadingLevel.HEADING_1,spacing:{before:220,after:80},border:{bottom:{style:BorderStyle.SINGLE,size:6,color:'1F3A5F',space:2}},children:[new TextRun({text:v,bold:true,font:FONT,size:25,color:'1F3A5F'})]}));
  else if(t==='h2') kids.push(new Paragraph({heading:HeadingLevel.HEADING_2,spacing:{before:200,after:80},children:[new TextRun({text:v,bold:true,font:FONT,size:21,color:'1F3A5F'})]}));
  else if(t==='p') kids.push(new Paragraph({spacing:{after:110,line:264},alignment:AlignmentType.JUSTIFIED,children:runs(v)}));
  else if(t==='bullet') kids.push(new Paragraph({numbering:{reference:'b',level:0},spacing:{after:70,line:264},children:runs(v)}));
  else if(t==='pagebreak') kids.push(new Paragraph({children:[new PageBreak()]}));
  else if(t==='img'){ const [w,h]=sizes[v]; const W=610; kids.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:120,after:160},keepLines:true,children:[new ImageRun({type:'png',data:fs.readFileSync(`../exhibits/f${v}.png`),transformation:{width:W,height:Math.round(W*h/w)},altText:{title:`Exhibit ${v}`,description:`Exhibit ${v}`,name:`ex${v}`}})]})); }
  else if(t==='table'){ const {rows,widths}=v; const tw=widths.reduce((a,b)=>a+b,0);
    kids.push(new Table({width:{size:tw,type:WidthType.DXA},columnWidths:widths,rows:rows.map((r,i)=>new TableRow({tableHeader:i===0,children:r.map((c,j)=>new TableCell({width:{size:widths[j],type:WidthType.DXA},borders:{top:border,bottom:border,left:border,right:border},margins:{top:60,bottom:60,left:80,right:80},shading:i===0?{type:ShadingType.CLEAR,color:'auto',fill:'1F3A5F'}:(i%2===0?{type:ShadingType.CLEAR,color:'auto',fill:'F2F4F8'}:undefined),children:[new Paragraph({children:[new TextRun({text:c,font:FONT,size:16,bold:i===0,color:i===0?'FFFFFF':'222222'})]})]}))}))})); }
}
const doc=new Document({creator:'Will Ritchings',title:'Why and Where We Lose New Logo Deals',
  styles:{default:{document:{run:{font:FONT,size:SZ}}},paragraphStyles:[
   {id:'Heading1',name:'Heading 1',basedOn:'Normal',next:'Normal',quickFormat:true,run:{font:FONT,size:25,bold:true,color:'1F3A5F'},paragraph:{outlineLevel:0}},
   {id:'Heading2',name:'Heading 2',basedOn:'Normal',next:'Normal',quickFormat:true,run:{font:FONT,size:21,bold:true,color:'1F3A5F'},paragraph:{outlineLevel:1}}]},
  numbering:{config:[{reference:'b',levels:[{level:0,format:LevelFormat.BULLET,text:'•',alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:360,hanging:240}}}}]}]},
  sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1080,bottom:1080,left:1080,right:1080}}},
    footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.RIGHT,children:[new TextRun({text:'Findigs Revenue Operations · Confidential · Page ',font:FONT,size:15,color:'777777'}),new TextRun({children:[PageNumber.CURRENT],font:FONT,size:15,color:'777777'})]})]})},
    children:kids}]});
Packer.toBuffer(doc).then(b=>{fs.writeFileSync('Why_and_Where_We_Lose_New_Logo_Deals.docx',b);console.log('ok')});
