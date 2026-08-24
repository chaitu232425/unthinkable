import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';

import { HomePage } from './pages/public/HomePage';
import { EventsPage } from './pages/public/EventsPage';
import { EventDetailPage } from './pages/public/EventDetailPage';
import { LoginPage } from './pages/auth/LoginPage';
import { RegisterPage } from './pages/auth/RegisterPage';
import { ForgotPasswordPage } from './pages/auth/ForgotPasswordPage';
import { CheckoutPage } from './pages/customer/CheckoutPage';
import { MyBookingsPage } from './pages/customer/MyBookingsPage';
import { BookingDetailPage } from './pages/customer/BookingDetailPage';
import { WaitlistPage } from './pages/customer/WaitlistPage';
import { OfferPage } from './pages/customer/OfferPage';
import { OrganiserDashboard } from './pages/organiser/OrganiserDashboard';
import { CreateEventPage } from './pages/organiser/CreateEventPage';
import { EventSummaryPage } from './pages/organiser/EventSummaryPage';
import { RevenuePage } from './pages/organiser/RevenuePage';
import { AdminDashboard } from './pages/admin/AdminDashboard';
import { VenuesPage } from './pages/admin/VenuesPage';
import { VenueDetailPage } from './pages/admin/VenueDetailPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        {/* public */}
        <Route path="/" element={<HomePage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        {/* the whole reset flow (email -> code -> new password) now lives in one page */}
        <Route path="/reset-password" element={<Navigate to="/forgot-password" replace />} />

        {/* customer */}
        <Route element={<ProtectedRoute roles={['CUSTOMER']} />}>
          <Route path="/checkout/:holdId" element={<CheckoutPage />} />
          <Route path="/bookings" element={<MyBookingsPage />} />
          <Route path="/bookings/:id" element={<BookingDetailPage />} />
          <Route path="/waitlist" element={<WaitlistPage />} />
          <Route path="/waitlist/offers/:offerId" element={<OfferPage />} />
        </Route>

        {/* organiser */}
        <Route element={<ProtectedRoute roles={['ORGANISER', 'ADMIN']} />}>
          <Route path="/organiser" element={<OrganiserDashboard />} />
          <Route path="/organiser/events/new" element={<CreateEventPage />} />
          <Route path="/organiser/events/:id" element={<EventSummaryPage />} />
          <Route path="/organiser/revenue" element={<RevenuePage />} />
        </Route>

        {/* admin */}
        <Route element={<ProtectedRoute roles={['ADMIN']} />}>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/venues" element={<VenuesPage />} />
          <Route path="/admin/venues/:id" element={<VenueDetailPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
