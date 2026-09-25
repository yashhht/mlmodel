from pathlib import Path
import csv, json, joblib, numpy as np
from sklearn.ensemble import RandomForestClassifier

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data'; RAW=DATA/'raw'; MODELS=DATA/'models'
MODELS.mkdir(exist_ok=True)

def num(v,d=0.0):
    try:return float(v)
    except:return d

def build_city(city):
    files=list((RAW/city).glob('*.csv'))
    by={}
    for fp in files:
        rows=list(csv.DictReader(open(fp,encoding='utf-8'))); by[fp.stem]=rows
    X=[]; y=[]
    station_names=list(by)
    for sid,rows in by.items():
        for i,row in enumerate(rows):
            t=num(row['temperature']); p=num(row['pressure']); rh=num(row['humidity']); prev=rows[max(0,i-1)]
            pt=num(prev['temperature'],t); pp=num(prev['pressure'],p); pr=num(prev['humidity'],rh)
            win=rows[max(0,i-20):i+1]
            vals=lambda key: np.array([num(r[key], {'temperature':t,'pressure':p,'humidity':rh}[key]) for r in win],dtype=float)
            def z(key,val):
                a=vals(key); return (val-a.mean())/(a.std()+1e-3)
            recent=rows[max(0,i-5):i+1]; temps=[num(r['temperature'],t) for r in recent]
            flat=1 if len(temps)>=4 and max(temps)-min(temps)<.03 else 0
            # same-time city reference (non-identical stations)
            refs=[]
            for other in station_names:
                if other==sid: continue
                rr=by[other][i]
                if rr['temperature']!='': refs.append(rr)
            nt=np.mean([num(r['temperature'],t) for r in refs]) if refs else t
            np_=np.mean([num(r['pressure'],p) for r in refs]) if refs else p
            nr=np.mean([num(r['humidity'],rh) for r in refs]) if refs else rh
            cross=max(0,abs(t-pt)/5-(abs(rh-pr)/15+abs(p-pp)/5))
            X.append([t-pt,p-pp,rh-pr,z('temperature',t),z('pressure',p),z('humidity',rh),flat,cross,t-nt,p-np_,rh-nr])
            y.append(int(row.get('fault_label') or 0))
    X=np.asarray(X,float); y=np.asarray(y,int)
    # Add deterministic jitter to make the synthetic classifier less brittle while preserving labels.
    rng=np.random.default_rng(42); X += rng.normal(0,.01,X.shape)
    model=RandomForestClassifier(n_estimators=24,max_depth=8,min_samples_leaf=4,class_weight='balanced',n_jobs=-1,random_state=42); model.fit(X,y)
    joblib.dump(model,MODELS/f'{city}.joblib')
    print(f'{city}: samples={len(y)} faults={int(y.sum())} -> {MODELS/f"{city}.joblib"}')

if __name__=='__main__':
    for city_dir in sorted(RAW.iterdir()):
        if city_dir.is_dir(): build_city(city_dir.name)
