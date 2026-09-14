import { createRoot } from 'react-dom/client'
import { TapPaymentDialog } from '../src/TapPaymentDialog'
import '../src/App.css'
import '../src/index.css'

const balance = Number(new URLSearchParams(location.search).get('balance') || 38910)
createRoot(document.getElementById('root')!).render(<TapPaymentDialog totalCents={38910} paidCents={38910 - balance} balanceCents={balance}
  items={[{ id: 'parts', label: 'Parts', cents: 23130 }, { id: 'labor', label: 'Labor', cents: 15780 }]}
  onCancel={() => { document.body.dataset.result = 'cancel' }}
  onCollect={amount => { document.body.dataset.result = String(amount) }} />)
