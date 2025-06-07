import React from 'react';

const EmployeeTable = ({ employees }) => (
  <table border="1" cellPadding="10" style={{ width: '100%', marginTop: 20 }}>
    <thead>
      <tr>
        <th>Nombre</th>
        <th>Cédula</th>
        <th>Correo</th>
        <th>Centro de Costo</th>
      </tr>
    </thead>
    <tbody>
      {employees.map(emp => (
        <tr key={emp.id}>
          <td>{emp.nombre}</td>
          <td>{emp.cedula}</td>
          <td>{emp.correo}</td>
          <td>{emp.centro_costo}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

export default EmployeeTable;