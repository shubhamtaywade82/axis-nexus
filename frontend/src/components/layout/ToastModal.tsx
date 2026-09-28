import { useApp } from '../../store/AppContext';
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react';

const icons = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
};

export function ToastContainer() {
  const { toasts } = useApp();

  return (
    <div className="fixed top-4 left-4 right-4 sm:left-auto z-[10000] flex flex-col items-end gap-1.5">
      {toasts.map((t) => {
        const Icon = icons[t.type];
        return (
          <div
            key={t.id}
            className={`slide-in flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-medium border max-w-[400px]
              ${t.type === 'success' ? 'bg-accent/8 border-accent/25 text-accent' : ''}
              ${t.type === 'error' ? 'bg-danger/8 border-danger/25 text-danger' : ''}
              ${t.type === 'warning' ? 'bg-gold/8 border-gold/25 text-gold' : ''}`}
          >
            <Icon size={14} />
            <span className="flex-1">{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ModalContainer() {
  const { modalContent, closeModal } = useApp();
  if (!modalContent) return null;

  return (
    <div
      className="fixed inset-0 bg-black/75 z-[9000] flex items-center justify-center backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div className="bg-surface-100 border border-border rounded-xl p-6 max-w-[560px] w-[92%] slide-in max-h-[88vh] overflow-y-auto relative">
        <button onClick={closeModal} className="absolute top-3 right-3 text-muted hover:text-white">
          <X size={16} />
        </button>
        {modalContent}
      </div>
    </div>
  );
}
