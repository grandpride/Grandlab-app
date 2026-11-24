#!/usr/bin/env python3
"""Replace every anon JWT in the repo's app files with the NEW anon key.
Usage: python3 swap-anon.py NEWKEY.txt [--apply]
Default = dry run (lists files only, changes nothing). Refuses non-anon keys."""
import re,sys,base64,json,os
def role(j):
    p=j.split('.')[1]; p+='='*(-len(p)%4)
    return json.loads(base64.urlsafe_b64decode(p)).get('role')
new=open(sys.argv[1]).read().strip()
assert role(new)=='anon', 'NEW key is not an anon key - stop'
apply='--apply' in sys.argv
root=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
n=0
for d,ds,fs in os.walk(root):
    ds[:]=[x for x in ds if x not in('node_modules','.git','.scratch-docs')]
    for f in fs:
        if not f.endswith(('.html','.js','.gs','.mjs','.json','.example')): continue
        p=os.path.join(d,f)
        try: t=open(p,encoding='utf-8').read()
        except: continue
        hits=[m for m in set(re.findall(r'eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+',t)) if m!=new]
        hits=[m for m in hits if role(m)=='anon']
        if not hits: continue
        for m in hits: t=t.replace(m,new)
        n+=1; print(('updated ' if apply else 'would update ')+os.path.relpath(p,root))
        if apply: open(p,'w',encoding='utf-8').write(t)
print(n,'files'+('' if apply else ' (dry run, nothing changed)'))
