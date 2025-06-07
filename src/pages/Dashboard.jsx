import React from 'react';
import EmployeeTable from '../components/EmployeeTable';

const Dashboard = () => {
  const empleados = [
    { id: 1, nombre: 'Ana Torres', cedula: '1720010010', correo: 'ana@empresa.com', centro_costo: 'Marketing' },
    { id: 2, nombre: 'Carlos Perez', cedula: '1720020020', correo: 'carlos@empresa.com', centro_costo: 'Ventas' }
  ];

  return (
    <div style={{ padding: 20 }}>
      <h1>Dashboard de Empleador</h1>
      <p>Total Empleados: {empleados.length}</p>
      <EmployeeTable employees={empleados} />
    </div>
  );
};

export default Dashboard;