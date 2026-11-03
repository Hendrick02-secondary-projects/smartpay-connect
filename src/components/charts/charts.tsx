"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMzn, formatMznCompact } from "@/lib/money";

const C = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const axis = { fontSize: 11, fill: "var(--muted-foreground)" };
const grid = { stroke: "var(--border)", strokeDasharray: "3 3", vertical: false };

function TooltipBox({ active, payload, label, money }: { active?: boolean; payload?: { name?: string; value?: number; color?: string }[]; label?: string; money?: boolean }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-lg">
      {label && <p className="mb-1 font-medium">{label}</p>}
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 tabular">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium">{money ? formatMzn(Number(p.value ?? 0)) : (p.value ?? 0).toLocaleString("pt-MZ")}</span>
        </p>
      ))}
    </div>
  );
}

const shortDay = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function VolumeChart({ data }: { data: { day: string; amountMinor: number; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" tickFormatter={shortDay} tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tickFormatter={(v: number) => formatMznCompact(v).replace(" MZN", "")} tick={axis} tickLine={false} axisLine={false} width={58} />
        <Tooltip content={<TooltipBox money />} labelFormatter={shortDay} />
        <Area type="monotone" dataKey="amountMinor" name="Valor pago" stroke="var(--chart-1)" strokeWidth={2} fill="url(#vol)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function SuccessFailChart({ data }: { data: { day: string; successful: number; failed: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ left: -16, right: 8, top: 8 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="day" tickFormatter={shortDay} tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
        <Tooltip content={<TooltipBox />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="successful" name="Bem-sucedidos" stackId="a" fill="var(--chart-3)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="failed" name="Falhados/cancelados" stackId="a" fill="var(--danger)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function HorizontalAmountBars({ data }: { data: { label: string; amountMinor: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
        <CartesianGrid {...grid} horizontal={false} vertical />
        <XAxis type="number" tickFormatter={(v: number) => formatMznCompact(v).replace(" MZN", "")} tick={axis} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="label" width={120} tick={{ ...axis, fill: "var(--foreground)" }} tickLine={false} axisLine={false} />
        <Tooltip content={<TooltipBox money />} cursor={{ fill: "var(--muted)" }} />
        <Bar dataKey="amountMinor" name="Valor" radius={[0, 4, 4, 0]} barSize={18}>
          {data.map((_, i) => (
            <Cell key={i} fill={C[i % C.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({ data, money = true }: { data: { label: string; value: number; color?: string }[]; money?: boolean }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div className="flex items-center gap-4">
      <ResponsiveContainer width="50%" height={180}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="92%" paddingAngle={2} stroke="none">
            {data.map((d, i) => (
              <Cell key={d.label} fill={d.color ?? C[i % C.length]} />
            ))}
          </Pie>
          <Tooltip content={<TooltipBox money={money} />} />
        </PieChart>
      </ResponsiveContainer>
      <ul className="flex-1 space-y-2 text-xs">
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-sm" style={{ background: d.color ?? C[i % C.length] }} />
              {d.label}
            </span>
            <span className="font-medium tabular">
              {money ? formatMznCompact(d.value) : d.value} <span className="text-muted-foreground">({total ? Math.round((d.value / total) * 100) : 0}%)</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GroupedMonthlyBars({
  data,
  series,
}: {
  data: Record<string, string | number>[];
  series: { key: string; label: string; color: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid {...grid} />
        <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(v: number) => formatMznCompact(v).replace(" MZN", "")} tick={axis} tickLine={false} axisLine={false} width={58} />
        <Tooltip content={<TooltipBox money />} cursor={{ fill: "var(--muted)" }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={28} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
