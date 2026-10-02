"""Create wholly synthetic JPEG test scenes. These are drawings, never camera/user photos.
Optional build-time utility only; Pillow is not a runtime dependency.
"""
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path
import random, hashlib, json, math
ROOT = Path(__file__).resolve().parents[1] / 'fixtures'
ROOT.mkdir(exist_ok=True)
manifest=[]
W,H=1200,800
palettes=[('#d7cab4','#6f7c70','#a96c47','#303e3c'),('#d6d1c7','#535552','#aaaba3','#242827'),('#b9c8c6','#556968','#c19262','#334949'),('#d8bd9f','#956b58','#ece2cf','#523e35'),('#c1bec7','#6c677d','#d0b5a1','#494052'),('#e7dcca','#9a9d8b','#b16a4c','#555f55')]
for i in range(12):
    random.seed(8300+i)
    bg,a,b,c=palettes[i%6]
    im=Image.new('RGB',(W,H),bg); d=ImageDraw.Draw(im)
    kind=i%6
    if kind==0:
        d.rectangle((0,510,W,H),fill=c)
        d.polygon([(70,220),(580,80),(580,730),(70,650)],fill=a)
        d.polygon([(580,80),(1050,220),(1050,660),(580,730)],fill=b)
        d.rectangle((690,285,890,510),fill=c)
        d.polygon([(580,730),(1050,660),(1200,720),(800,800)],fill='#253734')
        for x in range(140,500,95): d.line([(x,200-(x-140)*.24),(x,660+(x-140)*.15)],fill=bg,width=3)
    elif kind==1:
        d.rectangle((0,580,1200,800), fill=b)
        for j in range(8):
            x=80+j*140
            d.polygon([(x,0),(x+70,0),(x+70,600),(x,600)],fill=a)
            d.polygon([(x+70,600),(x+450,800),(x+330,800),(x,600)],fill=c)
        d.rectangle((525,440,541,601),fill=c); d.ellipse((521,412,547,441),fill=c)
    elif kind==2:
        for j in range(7):
            yy=230+j*72
            points=[(0,H)]+[(x,yy+45*math.sin(x/270+j*.7)) for x in range(0,W+20,20)]+[(W,H)]
            d.polygon(points,fill=[a,b,bg,c,a,b,c][j])
        d.ellipse((835,76,955,196),fill='#e0c594')
    elif kind==3:
        d.rectangle((0,0,480,H),fill=b)
        for j in range(9):
            x=260+j*105; y=640-j*66
            d.polygon([(x,y),(x+170,y),(x+170,800),(x,800)],fill=a)
            d.polygon([(x,y),(x+70,y-35),(x+240,y-35),(x+170,y)],fill=bg)
            d.line([(x,y),(x+170,y)],fill=c,width=2)
        d.rectangle((95,95,240,425),fill=c)
    elif kind==4:
        d.rectangle((220,0,1020,800),fill=a)
        d.rounded_rectangle((430,100,865,850),radius=217,fill=c)
        d.rectangle((430,320,865,800),fill=c)
        d.polygon([(430,500),(700,240),(700,800),(430,800)],fill=b)
        d.polygon([(865,470),(1200,750),(1200,800),(865,800)],fill='#aa8f88')
        d.rectangle((490,435,580,450),fill=bg)
    else:
        d.rectangle((0,490,W,H),fill=a)
        d.ellipse((220,135,665,580),fill=b)
        d.rectangle((440,120,880,600),fill=c)
        d.polygon([(880,600),(1200,800),(670,800),(440,600)],fill='#737b6e')
        d.rectangle((615,240,900,355),fill=bg)
        d.ellipse((600,445,860,675),fill=b)
    # Deterministic fine grain avoids claiming photograph provenance, and exercises byte-preservation.
    noise=Image.frombytes('L',(W,H),bytes(max(0,min(255,int(random.gauss(128,12)))) for _ in range(W*H))).convert('RGB')
    im=Image.blend(im,noise,.045)
    if i>=6:
        im=im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if i%2==0: im=im.convert('L').convert('RGB')
    name=f'R{i+1:07d}.JPG'; folder='100RICOH' if i<6 else '101RICOH'
    ident=hashlib.sha256((folder+'\0'+name).encode()).hexdigest()[:24]
    date=f'2026-09-{28 if i<6 else 29}T{9+i%6:02d}:24:00'
    exif=Image.Exif(); exif[0x010e]='SYNTHETIC FIXTURE - generated geometry, not a camera photograph'; exif[0x010f]='Prototype fixtures'; exif[0x0110]='No camera used'; exif[0x0132]=date.replace('-',':').replace('T',' ')
    im.save(ROOT/f'{ident}.jpg',quality=92,exif=exif)
    thumb=im.copy(); thumb.thumbnail((480,320)); thumb.save(ROOT/f'{ident}-thumb.jpg',quality=87)
    preview=im.copy(); preview.thumbnail((960,640)); preview.save(ROOT/f'{ident}-preview.jpg',quality=90)
    manifest.append(dict(id=ident,folder=folder,name=name,bytes=(ROOT/f'{ident}.jpg').stat().st_size,takenAt=date,width=W,height=H,synthetic=True))
(ROOT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Created',len(manifest),'synthetic fixture originals and previews')
