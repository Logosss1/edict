import { useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  message: string;
  okLabel: string;
  okClass?: string;
  onOk: (reason: string) => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, message, okLabel, okClass, onOk, onCancel }: Props) {
  const [reason, setReason] = useState('');

  // A hovered card is transformed, which otherwise becomes the containing
  // block for this fixed overlay and moves it under the pointer. Keep the
  // modal at the document root; React events still need propagation stopped.
  return createPortal(
    <div className="confirm-bg open" role="presentation" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="confirm-box" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-dialog-title" className="confirm-title">{title}</h2>
        <p className="confirm-msg">{message}</p>
        <textarea
          className="confirm-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="输入原因（可留空）"
          rows={2}
          autoFocus
        />
        <div className="confirm-btns">
          <button type="button" className="btn btn-g" onClick={onCancel}>返回</button>
          <button type="button" className={`btn btn-action ${okClass || ''}`} onClick={() => onOk(reason)}>
            {okLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
