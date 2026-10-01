import pandas as pd, numpy as np, matplotlib
matplotlib.use('Agg'); import matplotlib.pyplot as plt
df=pd.read_pickle('/home/claude/w/df2.pkl'); L=df[~df.won]
NAVY='#1F3A5F'; RED='#C53030'; GRAY='#8A94A6'; TEAL='#2C7A7B'; GOLD='#D69E2E'
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':9,'axes.spines.top':False,'axes.spines.right':False})
N=len(df); out={}
def save(f,name): f.tight_layout(); f.savefig(name,dpi=200); plt.close(f)
# 1 leaky bucket
st=['Intro & Challenge','Discovery / Demo','Business Case','Negotiation & Execution','Trial']
lost=[(L.hi==i).sum() for i in range(5)]; vals=lost+[df.won.sum()]; labs=[f'{s} → Lost' for s in st]+['Closed Won']
f,ax=plt.subplots(figsize=(7,3.2)); cols=[RED]*5+[TEAL]
b=ax.barh(labs[::-1],[v/N for v in vals][::-1],color=cols[::-1])
for r,v in zip(b,vals[::-1]): ax.text(r.get_width()+0.005,r.get_y()+r.get_height()/2,f'{v} ({v/N:.1%})',va='center')
ax.set_xlim(0,0.48); ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1,0)); ax.set_xlabel('% of 845 closed New Logo deals')
ax.set_title('Exhibit 1. Where closed deals exit (Oct 2025–Sep 2026)',loc='left',fontweight='bold'); save(f,'ex1.png')
# 2 monthly win rate + lost
m=df.groupby(df.close.dt.to_period('M')).agg(n=('won','size'),w=('won','sum')); m['l']=m.n-m.w; m['wr']=m.w/m.n
f,ax=plt.subplots(figsize=(7,3.2)); x=np.arange(12); lb=[p.strftime('%b %y') for p in m.index]
bb=ax.bar(x,m.l,color=GRAY,label='Closed Lost (count)')
for i,v in enumerate(m.l): ax.text(i,v+1,f'{v}\n{v/m.l.sum():.0%}',ha='center',fontsize=7)
ax.set_xticks(x); ax.set_xticklabels(lb,rotation=0,fontsize=7.5); ax.set_ylabel('Closed Lost deals'); ax.set_ylim(0,135)
a2=ax.twinx(); a2.plot(x,m.wr,color=RED,marker='o',label='Win rate'); a2.set_ylim(0,0.38); a2.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1,0)); a2.spines['top'].set_visible(False)
for i,v in enumerate(m.wr): a2.text(i,v+0.012,f'{v:.0%}',ha='center',color=RED,fontsize=7)
a2.set_ylabel('Win rate (count)'); h1,l1=ax.get_legend_handles_labels(); h2,l2=a2.get_legend_handles_labels(); ax.legend(h1+h2,l1+l2,loc='upper right',frameon=False,fontsize=8,bbox_to_anchor=(1,1.02))
ax.set_title('Exhibit 3. Monthly closed-lost volume and win rate',loc='left',fontweight='bold'); save(f,'ex2.png')
# 3 top reasons by tier
tier={0:'TOFU',1:'MOFU',2:'MOFU',3:'BOFU',4:'BOFU'}; L=L.assign(t=L.hi.map(tier))
f,axs=plt.subplots(1,3,figsize=(7.5,3.0))
for ax,t,c in zip(axs,['TOFU','MOFU','BOFU'],[RED,GOLD,NAVY]):
    s=L[L.t==t]['Reason Lost'].value_counts().head(5)[::-1]; tot=(L.t==t).sum()
    ax.barh(s.index,s.values,color=c)
    for i,v in enumerate(s.values): ax.text(v+tot*0.01,i,f'{v} ({v/tot:.0%})',va='center',fontsize=7.5)
    ax.set_title(f'{t} (n={tot})',fontsize=9,fontweight='bold'); ax.set_xlim(0,s.max()*1.55); ax.tick_params(axis='y',labelsize=7.5); ax.set_xticks([])
f.suptitle('Exhibit 4. Top closed-lost reasons by funnel tier (count, % of tier)',x=0.01,ha='left',fontweight='bold',fontsize=10); save(f,'ex3.png')
# 4 reason trend heatmap trailing 3-mo share
ct=pd.crosstab(L.close.dt.to_period('M'),L['Reason Lost']); order=L['Reason Lost'].value_counts().index; ct=ct[order]
r3=ct.rolling(3).sum(); sh=(r3.div(r3.sum(axis=1),axis=0)).iloc[2:]
f,ax=plt.subplots(figsize=(7.5,3.4)); im=ax.imshow(sh.T.values,cmap='OrRd',aspect='auto')
ax.set_yticks(range(len(order))); ax.set_yticklabels(order,fontsize=8); ax.set_xticks(range(len(sh))); ax.set_xticklabels([p.strftime('%b %y') for p in sh.index],fontsize=7.5)
for i in range(len(order)):
    for j in range(len(sh)): v=sh.T.values[i,j]; ax.text(j,i,f'{v:.0%}',ha='center',va='center',fontsize=6.5,color='white' if v>0.25 else 'black')
ax.set_title('Exhibit 5. Trailing 3-month share of closed-lost deals by reason',loc='left',fontweight='bold'); save(f,'ex4.png')
# 5 first vs last 6 months share change
h1=L[L.close<'2026-04-01']['Reason Lost'].value_counts(); h2=L[L.close>='2026-04-01']['Reason Lost'].value_counts()
d=pd.DataFrame({'h1':h1,'h2':h2}).fillna(0).loc[order]; d['s1']=d.h1/d.h1.sum(); d['s2']=d.h2/d.h2.sum(); d['dp']=d.s2-d.s1; d=d.sort_values('dp')
f,ax=plt.subplots(figsize=(7,3.2)); ax.barh(d.index,d.dp,color=[RED if v>0 else TEAL for v in d.dp])
for i,(k,r) in enumerate(d.iterrows()): ax.text(r.dp+(0.003 if r.dp>=0 else -0.003),i,f'{r.dp*100:+.1f} pts  ({int(r.h1)}→{int(r.h2)}; {r.s1:.0%}→{r.s2:.0%})',va='center',ha='left' if r.dp>=0 else 'right',fontsize=7)
ax.axvline(0,color='black',lw=0.6); ax.set_xlim(-0.26,0.22); ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1,0)); ax.set_xlabel('Change in share of closed-lost deals, Apr–Sep 2026 vs Oct 2025–Mar 2026')
ax.set_title('Exhibit 6. Loss-reason mix shift, last 6 vs first 6 months',loc='left',fontweight='bold'); save(f,'ex5.png')
out['h1h2']=d
# 6 segment funnel
segs=['SMB','Mid-Market','Enterprise']; mets=[('Reached Discovery',lambda g:(g.hi>=1).mean()),('Reached Negotiation',lambda g:(g.hi>=3).mean()),('Won',lambda g:g.won.mean())]
f,ax=plt.subplots(figsize=(7,3.0)); w=0.25; x=np.arange(3)
for k,(nm,fn) in enumerate(mets):
    v=[fn(df[df.seg==s]) for s in segs]; bars=ax.bar(x+(k-1)*w,v,w,label=nm,color=[NAVY,GOLD,TEAL][k])
    for xi,vi,s in zip(x+(k-1)*w,v,segs):
        cnt={'Reached Discovery':(df[df.seg==s].hi>=1).sum(),'Reached Negotiation':(df[df.seg==s].hi>=3).sum(),'Won':df[df.seg==s].won.sum()}[nm]
        ax.text(xi,vi+0.01,f'{vi:.0%}\n({cnt})',ha='center',fontsize=7)
ax.set_xticks(x); ax.set_xticklabels([f'{s} (n={(df.seg==s).sum()})' for s in segs]); ax.set_ylim(0,0.85); ax.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1,0)); ax.legend(frameon=False,fontsize=8)
ax.set_title('Exhibit 7. Funnel progression by segment (% of closed deals, count)',loc='left',fontweight='bold'); save(f,'ex6.png')
# 7 days in stage
f,ax=plt.subplots(figsize=(7,2.8)); stg=['Intro','Discovery','Business Case','Negotiation']
adv=[7.8,3.4,2.1,7.9]; los=[26.9,30.9,40.0,52.8]; x=np.arange(4)
ax.bar(x-0.18,adv,0.36,color=TEAL,label='Median days before advancing'); ax.bar(x+0.18,los,0.36,color=RED,label='Median days before being closed lost')
for i in range(4): ax.text(i-0.18,adv[i]+1,f'{adv[i]:.0f}',ha='center',fontsize=8); ax.text(i+0.18,los[i]+1,f'{los[i]:.0f}',ha='center',fontsize=8)
ax.set_xticks(x); ax.set_xticklabels(stg); ax.set_ylabel('Days'); ax.legend(frameon=False,fontsize=8)
ax.set_title('Exhibit 8. Time in stage: deals that advance vs deals that die',loc='left',fontweight='bold'); save(f,'ex7.png')
# 8 source win rate
s=df.groupby(df['Deal Source (SF)'].replace('','Unknown/Blank')).won.agg(['size','sum']); s=s[s['size']>=30]; s['wr']=s['sum']/s['size']; s=s.sort_values('wr')
f,ax=plt.subplots(figsize=(7,2.8)); ax.barh(s.index,s.wr,color=[RED if v==0 else NAVY for v in s.wr])
for i,(k,r) in enumerate(s.iterrows()): ax.text(r.wr+0.003,i,f'{r.wr:.1%}  ({int(r["sum"])} won / {int(r["size"])} closed; {r["size"]/N:.0%} of deals)',va='center',fontsize=7.5)
ax.set_xlim(0,0.25); ax.xaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1,0))
ax.set_title('Exhibit 9. Win rate by deal source (sources with n ≥ 30)',loc='left',fontweight='bold'); save(f,'ex8.png')
print(d[['h1','h2','s1','s2','dp']].round(3)); print(s)
# quarterly
q=df.groupby(df.close.dt.to_period('Q')).agg(n=('won','size'),w=('won','sum')); q['wr']=q.w/q.n; print(q)

q=df.groupby(df.close.dt.to_period('Q')).agg(n=('won','size'),w=('won','sum')); q['l']=q.n-q.w; q['wr']=q.w/q.n
f,ax=plt.subplots(figsize=(7,3.0)); x=np.arange(len(q)); lb=[f"Q{p.quarter} {p.year}" for p in q.index]
ax.bar(x-0.2,q.l,0.4,color=GRAY,label='Closed Lost'); ax.bar(x+0.2,q.w,0.4,color=TEAL,label='Closed Won')
for i in range(len(q)):
    ax.text(i-0.2,q.l.iloc[i]+4,f"{q.l.iloc[i]} ({q.l.iloc[i]/q.l.sum():.0%})",ha='center',fontsize=7.5)
    ax.text(i+0.2,q.w.iloc[i]+4,f"{q.w.iloc[i]} ({q.w.iloc[i]/q.w.sum():.0%})",ha='center',fontsize=7.5)
ax.set_xticks(x); ax.set_xticklabels(lb); ax.set_ylim(0,330); ax.set_ylabel('Deals')
a2=ax.twinx(); a2.plot(x,q.wr,color=RED,marker='o',label='Win rate'); a2.set_ylim(0,0.2); a2.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1,0)); a2.spines['top'].set_visible(False)
for i,v in enumerate(q.wr): a2.text(i+0.08,v+0.007,f'{v:.1%}',color=RED,fontsize=8,fontweight='bold')
h1,l1=ax.get_legend_handles_labels(); h2,l2=a2.get_legend_handles_labels(); ax.legend(h1+h2,l1+l2,loc='upper right',frameon=False,fontsize=8,ncol=3)
ax.set_title('Exhibit 2. Quarterly closed volume, wins, and win rate',loc='left',fontweight='bold'); save(f,'exq.png')
