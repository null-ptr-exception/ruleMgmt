import { Button, Card, Typography } from 'antd'
import { LoginOutlined } from '@ant-design/icons'

const { Title, Text } = Typography

export default function LoginPage() {
  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f5f5',
    }}>
      <Card style={{ width: 360, textAlign: 'center' }}>
        <Title level={3} style={{ marginBottom: 8 }}>Alert Template UI</Title>
        <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
          Sign in to manage alert templates and deployments
        </Text>
        <Button
          type="primary"
          size="large"
          icon={<LoginOutlined />}
          href="/api/auth/login"
        >
          Login with GitLab
        </Button>
      </Card>
    </div>
  )
}
