import React from 'react';

const Dashboard = () => {
  const empleados = [
    { id: 1, nombre: 'Ana Torres', cedula: '1720010010', correo: 'ana@empresa.com', centro_costo: 'Marketing' },
    { id: 2, nombre: 'Carlos Perez', cedula: '1720020020', correo: 'carlos@empresa.com', centro_costo: 'Ventas' },
  ];

  const totalBonosAsignados = 120.0;
  const totalGastado = 72.5;
  const porcentajeUsado = Math.round((totalGastado / totalBonosAsignados) * 100);

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <header className="text-2xl font-bold mb-6">Dashboard de Empleador</header>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-white shadow rounded-xl p-4">
          <h2 className="text-sm text-gray-500">Total Empleados</h2>
          <p className="text-2xl font-semibold">{empleados.length}</p>
        </div>
        <div className="bg-white shadow rounded-xl p-4">
          <h2 className="text-sm text-gray-500">Bonos Asignados</h2>
          <p className="text-2xl font-semibold">${totalBonosAsignados.toFixed(2)}</p>
        </div>
        <div className="bg-white shadow rounded-xl p-4">
          <h2 className="text-sm text-gray-500">% Usado</h2>
          <p className="text-2xl font-semibold">{porcentajeUsado}%</p>
        </div>
      </div>

      {/* Tabla de empleados */}
      <div className="bg-white shadow rounded-xl p-4">
        <h3 className="text-lg font-medium mb-4">Lista de Empleados</h3>
        <table className="w-full table-auto border-collapse">
          <thead>
            <tr className="bg-gray-100 text-left">
              <th className="p-2">Nombre</th>
              <th className="p-2">Cédula</th>
              <th className="p-2">Correo</th>
              <th className="p-2">Centro de Costo</th>
            </tr>
          </thead>
          <tbody>
            {empleados.map((emp) => (
              <tr key={emp.id} className="border-t">
                <td className="p-2">{emp.nombre}</td>
                <td className="p-2">{emp.cedula}</td>
                <td className="p-2">{emp.correo}</td>
                <td className="p-2">{emp.centro_costo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Dashboard;
