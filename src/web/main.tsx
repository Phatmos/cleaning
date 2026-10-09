import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Authed, setMe } from './components/Shell';
import './styles.css';
import { ToastProvider } from './components/ui';
import { Login } from './screens/Login';
import { Home } from './screens/Home';
import { Customers } from './screens/Customers';
import { CustomerDetail } from './screens/CustomerDetail';
import { EstimateScreen } from './screens/Estimate';
import { ProposalScreen } from './screens/Proposal';
import { ContractScreen } from './screens/Contract';
import { PublicProposal } from './screens/PublicProposal';
import { Admin } from './admin/Admin';

function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login onLogin={setMe} />} />
          <Route path="/p/:token" element={<PublicProposal />} />
          <Route path="/" element={<Authed><Home /></Authed>} />
          <Route path="/customers" element={<Authed><Customers /></Authed>} />
          <Route path="/customers/:id" element={<Authed><CustomerDetail /></Authed>} />
          <Route path="/estimates/:id" element={<Authed><EstimateScreen /></Authed>} />
          <Route path="/proposals/:id" element={<Authed><ProposalScreen /></Authed>} />
          <Route path="/contracts/:id" element={<Authed><ContractScreen /></Authed>} />
          <Route path="/admin/*" element={<Authed><Admin /></Authed>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
