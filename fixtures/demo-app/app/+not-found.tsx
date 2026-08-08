import { Link } from 'expo-router';
import { Text, View } from 'react-native';

export default function NotFound() {
  return (
    <View>
      <Text>Not found</Text>
      <Link href="/">Go home</Link>
    </View>
  );
}
