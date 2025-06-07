import React from 'react';
import { Home, Users, DollarSign, BarChart2, Bell, HelpCircle } from 'lucide-react';

const empleados = [
  { nombre: 'Maria G.', asignado: 500, consumido: 400, expiracion: '15/07/2025' },
  { nombre: 'Juan P.', asignado: 250, consumido: 200, expiracion: '10/06/2025' },
  { nombre: 'Ana R.', asignado: 250, consumido: 125, expiracion: '02/06/2025' },
  { nombre: 'Luis M.', asignado: 100, consumido: 65, expiracion: '30/05/2025' },
  { nombre: 'Elena S.', asignado: 150, consumido: 60, expiracion: '25/05/2025' },
];

const Sidebar = () => (
  <aside className="w-64 h-screen bg-green-100 p-4 flex flex-col text-sm">
    <h1 className="text-xl font-bold text-green-900 mb-6">ReVale.</h1>
    <nav className="space-y-4">
      <NavItem icon={<Home size={16} />} label="Dashboard" />
      <NavItem icon={<Users size={16} />} label="Empleados" />
      <NavItem icon={<DollarSign size={16} />} label="Bonos" />
      <NavItem icon={<BarChart2 size={16} />} label="Reportes" />
      <NavItem icon={<Bell size={16} />} label="Notificaciones" />
      <NavItem icon={<HelpCircle size={16} />} label="Soporte & contacto" />
    </nav>
  </aside>
);

const NavItem = ({ icon, label }) => (
  <div className="flex items-center gap-2 text-green-900 hover:text-green-600 cursor-pointer">
    {icon} <span>{label}</span>
  </div>
);

const Dashboard = () => {
  const totalAsignado = empleados.reduce((sum, e) => sum + e.asignado, 0);
  const totalConsumido = empleados.reduce((sum, e) => sum + e.consumido, 0);
  const porcentaje = Math.round((totalConsumido / totalAsignado) * 100);

  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 bg-green-50 p-8">
        <h2 className="text-xl font-semibold mb-6">Dashboard</h2>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatBox label="Bonos asignados" value={`$${totalAsignado}`} />
          <StatBox label="% de consumo" value={`${porcentaje}%`} />
          <StatBox label="Expiran pronto" value={`3 bonos`} />
          <StatBox label="Alertas activas" value={`4 alertas`} />
        </div>

        <div className="bg-white p-4 rounded-xl shadow">
          <h3 className="text-md font-semibold mb-4">Resumen de empleados</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-gray-600 border-b">
              <tr>
                <th className="p-2">Empleado</th>
                <th className="p-2">Monto asignado</th>
                <th className="p-2">Monto consumido</th>
                <th className="p-2">% consumo</th>
                <th className="p-2">Expiración</th>
              </tr>
            </thead>
            <tbody>
              {empleados.map((e, i) => (
                <tr key={i} className="border-b">
                  <td className="p-2">{e.nombre}</td>
                  <td className="p-2">${e.asignado}</td>
                  <td className="p-2">${e.consumido}</td>
                  <td className="p-2">{Math.round((e.consumido / e.asignado) * 100)}%</td>
                  <td className="p-2">{e.expiracion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
};

const StatBox = ({ label, value }) => (
  <div className="bg-green-200 rounded-xl p-4 text-green-900">
    <p className="text-sm">{label}</p>
    <h3 className="text-xl font-bold">{value}</h3>
  </div>
);

export default Dashboard;

