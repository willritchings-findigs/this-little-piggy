"""Statistics helpers shared by analysis scripts."""
import math
import numpy as np
from scipy import stats
from config import N_REPORTABLE, N_DIRECTIONAL

def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))

def flag(n):
    if n >= N_REPORTABLE: return "Reportable"
    if n >= N_DIRECTIONAL: return "Directional"
    return "Anecdotal (n<10): quotes only, no rates"

def compare_props(k1, n1, k2, n2):
    """Fisher exact for small cells, chi-square otherwise. Returns (p_value, test_name)."""
    if min(n1, n2) == 0:
        return (float("nan"), "n/a")
    table = [[k1, n1 - k1], [k2, n2 - k2]]
    exp_min = min((k1 + k2) * min(n1, n2) / (n1 + n2), (n1 + n2 - k1 - k2) * min(n1, n2) / (n1 + n2))
    if exp_min < 5:
        return (stats.fisher_exact(table)[1], "fisher")
    return (stats.chi2_contingency(table, correction=False)[1], "chi2")

def bh_qvalues(pvals):
    """Benjamini-Hochberg FDR q-values (NaNs preserved)."""
    p = np.array(pvals, dtype=float); q = np.full_like(p, np.nan)
    idx = np.where(~np.isnan(p))[0]
    if len(idx) == 0: return q
    ps = p[idx]; order = np.argsort(ps); m = len(ps)
    ranked = ps[order] * m / (np.arange(m) + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    q[idx[order]] = np.minimum(ranked, 1.0)
    return q

def cohen_kappa(a, b):
    a = list(a); b = list(b)
    cats = sorted(set(a) | set(b)); n = len(a)
    if n == 0: return float("nan")
    po = sum(x == y for x, y in zip(a, b)) / n
    pe = sum((a.count(c) / n) * (b.count(c) / n) for c in cats)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)
