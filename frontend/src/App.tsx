import { useState, useCallback, useEffect } from "react";
import { AppProvider, useApp } from "./store/AppContext";
import { Header } from "./components/layout/Header";
import { Sidebar } from "./components/layout/Sidebar";
import { ToastContainer, ModalContainer } from "./components/layout/ToastModal";
import { Dashboard } from "./pages/Dashboard";
import { Strategies } from "./pages/Strategies";
import { OptionsChain } from "./pages/OptionsChain";
import { Positions } from "./pages/Positions";
import { Orders } from "./pages/Orders";
import { AgentConsole } from "./pages/AgentConsole";
import { AgentMonitor } from "./pages/AgentMonitor";
import { AgentToolsMemory } from "./pages/AgentToolsMemory";
import { GreeksAnalytics } from "./pages/GreeksAnalytics";
import { OptionsAnalysis } from "./pages/OptionsAnalysis";
import { MarginRisk } from "./pages/MarginRisk";
import { SidekiqInfra } from "./pages/SidekiqInfra";
import { Alerts } from "./pages/Alerts";
import { Logs } from "./pages/Logs";
import { Config } from "./pages/Config";
import { ResearchConsole } from "./pages/ResearchConsole";
import { ScalpMonitor } from "./pages/ScalpMonitor";
import { api } from "./services/api";
import { openDeployStrategyModal } from "./pages/DeployModal";

const PAGE_TITLES: Record<string, [string, string]> = {
  dashboard: ["Dashboard", "LIVE OVERVIEW"],
  strategies: ["Strategies", "AASM STATE MACHINE BACKED"],
  "options-chain": ["Option Chain", "LIVE DHAN /v2/optionchain"],
  "options-analysis": ["Options Behavior", "DYNAMIC ATM & PARALLEL BUYING"],
  positions: ["Positions", "OPTIMISTIC LOCKING (AR)"],
  orders: ["Order Book", "FULL AUDIT TRAIL"],
  "agent-console": ["Agent Console", "REACT MULTI-AGENT LOOP"],
  "research-console": ["Research Console", "INSTITUTIONAL EQUITY INTELLIGENCE"],
  "scalp-monitor": ["Scalp Monitor", "FEE-AWARE BOTH-SIDE RATCHET"],
  "agent-monitor": ["Ops Telemetry", "AGENT INTERNAL METRICS"],
  "agent-tools-memory": ["Tools & Memory", "PILLARS 2 & 3"],
  "greeks-analytics": ["Greeks & Volatility", "ANALYTICS & IV SURFACE"],
  "margin-risk": ["Margin & Risk", "DHAN HEDGE & CIRCUIT BREAKERS"],
  "sidekiq-infra": ["Sidekiq & Infra", "BACKGROUND JOBS & PUMA"],
  alerts: ["Alerts", "ACTIVESUPPORT NOTIFICATIONS"],
  logs: ["Logs & Traces", "TAGGED REQUEST_ID"],
  config: ["Configuration", "SYSTEM & BROKER PARAMS"],
};

function AppInner() {
  const { setState, openModal, closeModal, showToast, addSystemLog, refreshPortfolio, refreshControlState } = useApp();
  const [page, setPage] = useState(() => location.hash.replace('#', '') || 'dashboard');

  useEffect(() => {
    const onHash = () => setPage(location.hash.replace('#', '') || 'dashboard');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const handleNavigate = useCallback((id: string) => {
    location.hash = id;
    setPage(id);
  }, []);

  const handleKillSwitch = useCallback(() => {
    openModal(
      <div className="text-center">
        <div className="w-14 h-14 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-3 text-danger text-2xl">
          ⚠
        </div>
        <div className="text-base font-bold text-danger mb-1">
          EMERGENCY KILL SWITCH
        </div>
        <div className="text-xs text-muted mb-4">
          This will immediately cancel all orders, close all positions, and stop
          all strategies.
        </div>
        <div className="bg-surface-50 border border-danger/20 rounded p-3 mb-4">
          <div className="text-[9.5px] font-mono text-muted uppercase mb-1">
            Type CONFIRM to execute:
          </div>
          <input
            type="text"
            className="w-full bg-bg border border-border rounded-md px-3 py-[7px] text-[12px] font-mono text-white outline-none text-center font-bold"
            id="killSwitchInput"
            placeholder="CONFIRM"
            autoComplete="off"
          />
        </div>
        <div className="flex gap-2 justify-center">
          <button
            className="px-4 py-[7px] rounded-md text-xs font-semibold bg-transparent text-muted border border-border hover:text-white hover:border-[#2a3d5e] hover:bg-surface-200 transition-all"
            onClick={closeModal}
          >
            Cancel
          </button>
          <button
            className="px-4 py-[7px] rounded-md text-xs font-semibold bg-danger text-white hover:bg-[#ff5c78] transition-all"
            onClick={async () => {
              const input = document.getElementById(
                "killSwitchInput",
              ) as HTMLInputElement;
              if (!input || input.value !== "CONFIRM") {
                showToast("Type CONFIRM to proceed", "error");
                return;
              }
              closeModal();
              try {
                // REAL kill switch — executed by the backend risk engine:
                // squares off every open position and halts the system.
                const result = await api.armKillSwitch("Manual kill switch from control plane UI");
                setState((prev) => ({
                  ...prev,
                  killed: true,
                  live: false,
                  strategies: prev.strategies.map((s) => ({
                    ...s,
                    status: "STOPPED" as const,
                  })),
                }));
                addSystemLog(
                  "ERROR",
                  `*** EMERGENCY KILL SWITCH ACTIVATED (backend confirmed: ${result.status}, ${result.details?.positionsClosed ?? 0} positions closed) ***`,
                  "risk_engine",
                );
                showToast(`KILL SWITCH ENGAGED — ${(result.details?.positionsClosed ?? 0)} position(s) squared off`, "error");
                await Promise.all([refreshPortfolio(), refreshControlState()]);
              } catch (e: any) {
                showToast(`Kill switch failed: ${e.message}`, "error");
              }
            }}
          >
            Execute Kill Switch
          </button>
        </div>
      </div>,
    );
  }, [openModal, closeModal, setState, addSystemLog, showToast]);

  const [title, subtitle] = PAGE_TITLES[page] || ["Overview", ""];

  const renderPage = () => {
    switch (page) {
      case "dashboard":
        return (
          <Dashboard
            onNavigate={handleNavigate}
            onDeploy={() =>
              openDeployStrategyModal(
                openModal,
                closeModal,
                setState,
                addSystemLog,
                showToast,
                refreshPortfolio,
              )
            }
          />
        );
      case "strategies":
        return (
          <Strategies
            onDeploy={() =>
              openDeployStrategyModal(
                openModal,
                closeModal,
                setState,
                addSystemLog,
                showToast,
                refreshPortfolio,
              )
            }
          />
        );
      case "options-chain":
        return <OptionsChain />;
      case "options-analysis":
        return <OptionsAnalysis />;
      case "positions":
        return <Positions />;
      case "orders":
        return <Orders />;
      case "agent-console":
        return <AgentConsole />;
      case "research-console":
        return <ResearchConsole />;
      case "scalp-monitor":
        return <ScalpMonitor />;
      case "agent-monitor":
        return <AgentMonitor />;
      case "agent-tools-memory":
        return <AgentToolsMemory />;
      case "greeks-analytics":
        return <GreeksAnalytics />;
      case "margin-risk":
        return <MarginRisk />;
      case "sidekiq-infra":
        return <SidekiqInfra />;
      case "alerts":
        return <Alerts />;
      case "logs":
        return <Logs />;
      case "config":
        return <Config />;
      default:
        return (
          <Dashboard
            onNavigate={handleNavigate}
            onDeploy={() =>
              openDeployStrategyModal(
                openModal,
                closeModal,
                setState,
                addSystemLog,
                showToast,
              )
            }
          />
        );
    }
  };

  return (
    <div className="bg-grid flex flex-col h-screen overflow-hidden">
      <ToastContainer />
      <ModalContainer />
      <Header
        pageTitle={title}
        pageSubtitle={subtitle}
        onKillSwitch={handleKillSwitch}
      />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar activePage={page} onNavigate={handleNavigate} />
        <main className="flex-1 overflow-y-auto p-5">{renderPage()}</main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
