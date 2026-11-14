"""Produce a Go-linkable COFF .syso with RT_ICON + RT_GROUP_ICON resources.
Use only Python standard library; compatible with Windows/AMD64 Go.
"""
import struct
from pathlib import Path
root=Path(__file__).parent.parent
ico=(root/'MpolMessenger.ico').read_bytes()
reserved,ico_type,count=struct.unpack_from('<HHH',ico,0)
assert ico_type==1
images=[]
for i in range(count):
  width,height,colors,zero,planes,bpp,size,ofs=struct.unpack_from('<BBBBHHII',ico,6+i*16)
  images.append((width,height,colors,planes,bpp,ico[ofs:ofs+size]))
# Group icon dir references numeric resource IDs 1..N
igroup=struct.pack('<HHH',0,1,count)
for i,(width,height,colors,planes,bpp,data) in enumerate(images,1):
  igroup+=struct.pack('<BBBBHHIH',width,height,colors,0,planes,bpp,len(data),i)

# image resource tree: root types 3 and 14; icon 1..N; group 1; language 1033.
# IMAGE_RESOURCE_DIRECTORY uses offsets relative to section start.
section=bytearray()
def alloc(n,align=4):
  while len(section)%align: section.append(0)
  at=len(section);section.extend(b'\0'*n);return at
def put(at,fmt,*vals):struct.pack_into(fmt,section,at,*vals)
def directory(entries):
  at=alloc(16+len(entries)*8)
  put(at,'<IIHHHH',0,0,0,0,0,len(entries))
  for j,(ident,target,isdir) in enumerate(entries):put(at+16+j*8,'<II',ident,target|(0x80000000 if isdir else 0))
  return at
# allocate directory nodes first (no parent pointers yet)
root_dir=directory([(3,0,True),(14,0,True)])
icon_dir=directory([(i,0,True) for i in range(1,len(images)+1)])
group_dir=directory([(1,0,True)])
icon_languages=[directory([(1033,0,False)]) for _ in images]
group_language=directory([(1033,0,False)])
icon_data_entries=[alloc(16) for _ in images]
group_data_entry=alloc(16)
# Link tree
put(root_dir+16+4,'<I',icon_dir|0x80000000)
put(root_dir+24+4,'<I',group_dir|0x80000000)
for i,language in enumerate(icon_languages):
  put(icon_dir+16+i*8+4,'<I',language|0x80000000)
  put(language+16+4,'<I',icon_data_entries[i])
put(group_dir+16+4,'<I',group_language|0x80000000)
put(group_language+16+4,'<I',group_data_entry)

relocations=[]
for (width,height,colors,planes,bpp,data),entry in zip(images,icon_data_entries):
  at=alloc(len(data));section[at:at+len(data)]=data
  put(entry,'<IIII',at,len(data),0,0)
  relocations.append(entry)
grp_at=alloc(len(igroup));section[grp_at:grp_at+len(igroup)]=igroup
put(group_data_entry,'<IIII',grp_at,len(igroup),0,0)
relocations.append(group_data_entry)

header_size=20+40
raw=header_size
relptr=raw+len(section)
symptr=relptr+len(relocations)*10
coff=bytearray()
coff+=struct.pack('<HHIIIHH',0x8664,1,0,symptr,1,0,0)
coff+=struct.pack('<8sIIIIIIHHI',b'.rsrc\0\0\0',0,0,len(section),raw,relptr,0,len(relocations),0,0x40000040)
coff+=section
for addr in relocations:coff+=struct.pack('<IIH',addr,0,3) # AMD64 ADDR32NB
coff+=struct.pack('<8sIhHBB',b'.rsrc\0\0\0',0,1,0,3,0)
coff+=struct.pack('<I',4)
(root/'client'/'rsrc_windows_amd64.syso').write_bytes(coff)
print('Resource: icons',len(images),'section bytes',len(section),'relocations',len(relocations))
