"""PHIA end to end: attribute every C (AskWearables) run on an answerable question to one outcome (paper, "Why AskWearables lost on answerable PHIA questions").
Needs the full run rows in eval/data/results/phia-*.full.jsonl (written by run.ts; gitignored because PHIA is CC BY-NC 4.0)
and the PHIA data under eval/data/phia. Usage: eval/.venv/bin/python eval/paper/phia_failures.py"""
import json,re,glob,collections as C
import os; R=os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')) + '/'
def load(paths):
    rows={}; step=set()
    for p in paths:
        for line in open(p):
            if not line.strip(): continue
            r=json.loads(line); key=(r['condition'],r['model'],r['task'],r['run'])
            if key in step: continue
            if r.get('error')=='max_steps':
                r.update(answer=None,correct=False,correct_phia=False,correct_as_worded=False,max_steps=True); rows[key]=r; step.add(key); continue
            if r.get('error') and re.search(r"maximum context length|context window|too many tokens",r['error'],re.I):
                r.update(answer=None,correct=False,correct_phia=False,correct_as_worded=False,ctx=True); rows[key]=r; continue
            if r.get('error'): rows[key]=None; continue
            rows[key]=r
    ok=[r for r in rows.values() if r]
    for r in ok:
        if 'accept' in r and 'ANSWER' not in (r.get('final') or '').upper():
            r['answer']=None; r['correct']=r['correct_phia']=r['correct_as_worded']=False; r['noanswerline']=True
    return ok
V2=os.environ.get('EVAL_PHIA_V2')=='1'
if V2:
    # Second iteration: rows of the fresh sample, from the shared file (first pass) and the v2 directory.
    v2ids={'phia'+i['id'].replace(':','_') for i in json.load(open(R+'eval/paper/benchmarks/phia_sample_v2.json'))['items']}
    full=[r for r in load([R+'eval/data/results/phia-open.full.jsonl']+sorted(glob.glob(R+'eval/data/results/v2/phia-*.full.jsonl'))) if r['task'] in v2ids]
else:
    full=load([R+'eval/data/results/phia-frontier.full.jsonl',R+'eval/data/results/phia-open.full.jsonl'])
    full=[r for r in full if r['task'] in {'phia'+i['id'].replace(':','_') for i in json.load(open(R+'eval/paper/benchmarks/phia_sample.json'))['items']}]
com=load(sorted(glob.glob(R+'eval/paper/results/final/phia-*.jsonl')))
mapping={e['id']:e for e in json.load(open(R+'eval/phia/mapping.json'))['entries']}
import csv
P={'465':'health_behavior','333':'sedentary_sleeper','171':'inactive_insomniacs','41':'active_achiver'}
Q={}
for u,p in P.items():
    for i,row in enumerate(csv.DictReader(open(R+f'eval/data/phia/data/auto_eval/{p}_final_v2.csv'))):
        Q[f'{u}:{i}']=row
MODELS=["llama-3.3-70b","llama-4-scout","mistral-small-3.1","gemma-4-26b","gpt-oss-20b","gpt-oss-120b","gemini-4-neon","gpt-6.2-astra","claude-fable-5.2"]
full=[r for r in full if r['model'] in MODELS]
tid=lambda t: t[4:].replace('_',':')
sample={i['id']:i for i in json.load(open(R+'eval/paper/benchmarks/phia_sample.json'))['items']}
dry={json.loads(l)['id']:json.loads(l) for l in open(R+('eval/data/benchmarks/phia_labels_v2.jsonl' if V2 else 'eval/data/benchmarks/benchdry_phia_llm.jsonl'))}
drynone={json.loads(l)['id']:json.loads(l) for l in open(R+'eval/data/benchmarks/benchdry_phia_none.jsonl')}
import math
def sig2(x):
    if x==0: return 0
    return float(f"{x:.2g}")
def agree2(a,b):
    try: return sig2(float(a))==sig2(float(b))
    except: return False
def classify(r):
    t=tid(r['task']); d=dry[r['task']]; lab=d['phia']['label']; aw=d['phia']['as_worded']
    if r['correct_phia']: return 'correct'
    if r.get('max_steps'): return 'max_steps'
    if r.get('ctx'): return 'context'
    if r.get('noanswerline'): return 'no_ANSWER_line'
    pk=r.get('packets_released') or []
    lv=r.get('packet_levels') or []
    if not lv: return 'no_tool_call'
    num=[p for p in pk if p and p.get('findings') and any(('value' in f) for f in p['findings'])]
    if not num:
        if all(l=='unsupported' for l in lv): return 'planner_refused_all'
        if all(l in('unsupported','denied') for l in lv): return 'denied(heart_rate etc)' if 'denied' in lv else 'refused'
        if any(l==0 for l in lv): return 'level0_flag_only'
        return 'other_nonnum'
    vals=[]
    for p in num:
        for f in p['findings']:
            if 'value' in f: vals.append(f['value'])
            for v in f.get('values') or []: vals.append(v['value'])
    if any(agree2(v,lab) for v in vals): return 'packet_had_label_agent_wrong'
    if aw is not None and any(agree2(v,aw) for v in vals) and r['answer'] is not None and agree2(r['answer'],aw): return 'window_convention(correct_as_worded)'
    if r['answer'] is not None and agree2(r['answer'],lab): return 'x'
    if r['answer']=='unknown' or r['answer'] is None: return 'numeric_packet_agent_said_unknown'
    return 'numeric_packet_wrong_value'
DATEQ=re.compile(r"\b(on (what|which) (day|date)|what date|which date|when (was|did)|all (available|my)|history|ever|recorded in my data|across all|over all)\b",re.I)
def mainvals(p):
    # A level-1 threshold count carries its count in the statement ("... on 3 of 7 nights").
    out=[f['value'] for f in p['findings'] if 'value' in f]
    for f in p['findings']:
        m=re.search(r' on (\d+) of \d+ ', f.get('statement',''))
        if 'value' not in f and m: out.append(int(m.group(1)))
    return out
def classify2(r):
    d=dry[r['task']]; lab=d['phia']['label']; aw=d['phia']['as_worded']
    if r['correct_phia']: return 'correct'
    if r.get('max_steps'): return 'fmt:max_steps'
    if r.get('noanswerline') or r.get('ctx'): return 'fmt:no_ANSWER_line'
    lv=r.get('packet_levels') or []; pk=r.get('packets_released') or []
    qs=[]
    for x in r['transcript_tools']:
        if x['name']=='ask_wearables':
            try: qs.append(json.loads(x['args']).get('question',''))
            except: qs.append(x['args'])
    if not lv: return 'no_tool_call'
    num=[p for p in pk if p and p.get('findings') and mainvals(p)]
    if not num:
        if 'denied' in lv: return 'gate_denied(heart_rate)'
        if all(l=='unsupported' for l in lv):
            return 'planner_refused:agent_asked_date/all-history' if any(DATEQ.search(q) for q in qs) else 'planner_refused:other'
        if any(l==0 for l in lv): return 'threshold_level0_flag_only'
        return 'other_nonnum'
    mv=[v for p in num for v in mainvals(p)]
    hit_l=any(agree2(v,lab) for v in mv); hit_w=aw is not None and any(agree2(v,aw) for v in mv)
    a=r['answer']
    if hit_l:
        return 'agent:packet_right_answered_unknown' if a in (None,'unknown') else 'agent:packet_right_answered_other'
    if hit_w:
        return 'definition:N+1_window(as_worded_value_released)' 
    if a in (None,'unknown'): return 'spec/window_wrong+unknown'
    return 'spec/window_wrong_value'
import collections as C
only=os.environ.get('EVAL_MODELS')
c=[r for r in full if r['condition']=='C_broker' and r.get('stratum')!='unsupported' and (not only or r['model'] in only.split(','))]
print('C answerable runs',len(c))
cnt=C.Counter(classify2(r) for r in c)
for k,v in cnt.most_common(): print(f'{v:5} {k}')
